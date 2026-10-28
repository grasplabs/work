/**
 * Who a rollout reaches and in what order, and what each client ran
 * before it did.
 *
 * Ring 0 is Grasp's own deployments (`grasp-os-internal`): every rollout
 * reaches them first, then, once a staff member approves, what it was
 * started for: one ring, one client, or every client, ring by ring, with
 * no approval between them (src/rollout/workflow.ts). Each is a client
 * placed in a hosting destination, whose one operation a rollout runs for
 * its release (src/hosting/operation.ts).
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { z } from "zod";

import type { AdminDatabase } from "../db/act.ts";
import {
  clientPlacements,
  clientProvisions,
  clients,
  clientWorkers,
  releases,
  rolloutTargets,
} from "../db/schema.ts";

/** The ring every rollout reaches first: Grasp's own deployments. */
export const firstRing = 0;

/** What a rollout is started for, besides ring 0. */
export const rolloutScopeSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("all") }),
  z.object({ scope: z.literal("ring"), ring: z.int().nonnegative() }),
  z.object({ scope: z.literal("client"), clientId: z.string().min(1) }),
]);
export type RolloutScope = z.infer<typeof rolloutScopeSchema>;

/** A client a rollout reaches, and the ring it's reached in. */
export interface RolloutTarget {
  clientId: string;
  ring: number;
}

/** Which clients `scope` names, besides ring 0's; undefined for every client. */
const scopeFilter = (scope: RolloutScope): SQL | undefined => {
  if (scope.scope === "all") {
    return undefined;
  }
  return scope.scope === "ring"
    ? inArray(clients.ring, [firstRing, scope.ring])
    : or(eq(clients.ring, firstRing), eq(clients.id, scope.clientId));
};

/** Targets in the order a rollout reaches them: by ring, then by client. */
const byRing = (a: RolloutTarget, b: RolloutTarget): number =>
  a.ring - b.ring || a.clientId.localeCompare(b.clientId);

/**
 * The active placed clients a rollout for `scope` reaches, each in the
 * ring it's in now: ring 0's, and the scope's. In the order it reaches
 * them. One that isn't placed has no operation to run.
 */
export const targetsOf = async (
  db: AdminDatabase,
  scope: RolloutScope
): Promise<RolloutTarget[]> => {
  const rows = await db
    .select({ clientId: clients.id, ring: clients.ring })
    .from(clients)
    .innerJoin(clientPlacements, eq(clientPlacements.clientId, clients.id))
    .where(and(eq(clients.status, "active"), scopeFilter(scope)));
  return rows.toSorted(byRing);
};

/** A rollout's targets grouped by ring, in the order it reaches them. */
export interface RingOfTargets {
  ring: number;
  clientIds: string[];
}

/** Rollout `rolloutId`'s targets, ring by ring. */
export const ringsOf = async (
  db: AdminDatabase,
  rolloutId: string
): Promise<RingOfTargets[]> => {
  const rows = await db
    .select({ clientId: rolloutTargets.clientId, ring: rolloutTargets.ring })
    .from(rolloutTargets)
    .where(eq(rolloutTargets.rolloutId, rolloutId));
  const rings: RingOfTargets[] = [];
  for (const { clientId, ring } of rows.toSorted(byRing)) {
    const last = rings.at(-1);
    if (last?.ring === ring) {
      last.clientIds.push(clientId);
    } else {
      rings.push({ ring, clientIds: [clientId] });
    }
  }
  return rings;
};

/**
 * What a client ran before a rollout reached it: the release it last ran
 * whole, which a rollback takes it back to, and its secrets generation
 * then. `versions` is what each Worker ran, where known; a rollback runs
 * the release again rather than put versions back, with the client's
 * current secrets.
 */
export const previousRunSchema = z.object({
  release: z.string().nullable(),
  generation: z.int().nullable(),
  versions: z.record(z.string(), z.string()),
  /**
   * Each Worker's shared secrets as last delivered, by name with its keyed
   * fingerprint: what proves a secrets rollout rotated one
   * (src/rollout/shared-secrets.ts).
   */
  shared: z.record(z.string(), z.record(z.string(), z.string())).optional(),
});
export type PreviousRun = z.infer<typeof previousRunSchema>;

/** The client a rollout reaches, as it reads it. */
export interface TargetClient {
  id: string;
  status: "provisioning" | "active" | "offboarded";
  /** Its secrets generation, from 1 (src/deploy/rotation.ts). */
  generation: number;
  /**
   * Its one operation (src/hosting/operation.ts): the release it last
   * worked on, how it ended, and the release before; null for a client
   * that isn't placed.
   */
  operation: {
    releaseId: string;
    status: "running" | "failed" | "done";
    previousReleaseId: string | null;
    /** How many changes it started: each release, run again and rollback. */
    change: number;
    /** Each Worker's shared secrets as last delivered, by name with its fingerprint. */
    shared: Record<string, Record<string, string>>;
  } | null;
  pinnedReleaseId: string | null;
  /**
   * Whether its secrets rotated and no deploy made the new generation
   * live yet (src/deploy/rotation.ts): a deploy must still reach it.
   */
  rotationPending: boolean;
  /**
   * Whether staff changed its sign-in or a setting after its core last
   * went live with them (`clients.configChangedAt`): a run must still take
   * the change to its core.
   */
  configPending: boolean;
  /**
   * The Workers the admin deployed to it, with the release it last made
   * live on each and when that release was built.
   */
  workers: {
    worker: string;
    scriptName: string;
    releaseId: string | null;
    releaseBuiltAt: Date | null;
  }[];
}

/**
 * Whether client `clientId`'s config, changed at `configChangedAt`, waits
 * for a run: its operation isn't done, or its core went live with the
 * settings as read no later than the change (`configuredAt`, recorded
 * once core's upload is observed), however often that run was resumed.
 */
export const isConfigPending = async (
  db: AdminDatabase,
  clientId: string,
  configChangedAt: Date | null
): Promise<boolean> => {
  if (configChangedAt === null) {
    return false;
  }
  const operation = await db
    .select({
      status: clientProvisions.status,
      configuredAt: sql<
        string | null
      >`json_extract(${clientProvisions.progress}, '$.configuredAt')`,
    })
    .from(clientProvisions)
    .where(eq(clientProvisions.clientId, clientId))
    .get();
  if (operation?.status !== "done" || operation.configuredAt === null) {
    return true;
  }
  return Date.parse(operation.configuredAt) <= configChangedAt.getTime();
};

const deliveredSchema = z
  .object({
    shared: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  })
  .loose();

/** The shared-secret fingerprints an operation's progress records, by Worker. */
export const deliveredShared = (
  progress: string | null
): Record<string, Record<string, string>> => {
  const parsed = deliveredSchema.safeParse(JSON.parse(progress ?? "{}"));
  return parsed.success ? (parsed.data.shared ?? {}) : {};
};

/** Client `clientId`, as a rollout reads it; undefined when it's gone. */
export const targetClient = async (
  db: AdminDatabase,
  clientId: string
): Promise<TargetClient | undefined> => {
  const [client] = await db
    .select({
      id: clients.id,
      status: clients.status,
      generation: clients.generation,
      pinnedReleaseId: clients.pinnedReleaseId,
      rotatedAt: clients.rotatedAt,
      rotationLiveAt: clients.rotationLiveAt,
      configChangedAt: clients.configChangedAt,
    })
    .from(clients)
    .where(eq(clients.id, clientId));
  if (client === undefined) {
    return undefined;
  }
  const { rotatedAt, rotationLiveAt, configChangedAt, ...rest } = client;
  const workers = await db
    .select({
      worker: clientWorkers.worker,
      scriptName: clientWorkers.scriptName,
      releaseId: clientWorkers.releaseId,
      releaseBuiltAt: releases.builtAt,
    })
    .from(clientWorkers)
    .leftJoin(releases, eq(releases.id, clientWorkers.releaseId))
    .where(eq(clientWorkers.clientId, clientId));
  const row = await db
    .select({
      releaseId: clientProvisions.releaseId,
      status: clientProvisions.status,
      previousReleaseId: clientProvisions.previousReleaseId,
      change: clientProvisions.change,
      progress: clientProvisions.progress,
    })
    .from(clientProvisions)
    .where(eq(clientProvisions.clientId, clientId))
    .get();
  let operation: TargetClient["operation"] = null;
  if (row !== undefined) {
    const { progress, ...fields } = row;
    operation = { ...fields, shared: deliveredShared(progress) };
  }
  return {
    ...rest,
    operation,
    rotationPending: rotatedAt !== null && rotationLiveAt === null,
    configPending: await isConfigPending(db, clientId, configChangedAt),
    workers,
  };
};

/** A release, and when it was built: what orders releases. */
export interface ReleaseAt {
  id: string;
  builtAt: Date;
}

/**
 * Why a rollout of `release` skips `client`, or null when it deploys it:
 * it's pinned to another release (`pinned`), whatever it runs now;
 * every Worker runs the release already and neither a secrets rotation
 * nor a config change waits for a deploy (`on_release`); or one runs a
 * release built after it (`newer`), which the release's code may not run
 * against (migrations only expand for the release after), unless the
 * client is pinned to this release.
 */
export const skipReason = (
  client: TargetClient,
  release: ReleaseAt
): string | null => {
  if (
    client.pinnedReleaseId !== null &&
    client.pinnedReleaseId !== release.id
  ) {
    return "pinned";
  }
  if (
    !client.rotationPending &&
    !client.configPending &&
    client.workers.length > 0 &&
    client.workers.every((worker) => worker.releaseId === release.id)
  ) {
    return "on_release";
  }
  const newer = client.workers.some(
    ({ releaseBuiltAt }) =>
      releaseBuiltAt !== null && releaseBuiltAt > release.builtAt
  );
  return newer && client.pinnedReleaseId !== release.id ? "newer" : null;
};

/**
 * The release every Worker of `client` runs, as the admin last made it
 * live; null when they don't run one release (none deployed yet, or a
 * deploy stopped between them).
 */
export const runningRelease = (client: TargetClient): string | null => {
  const onReleases = new Set(client.workers.map(({ releaseId }) => releaseId));
  const [release = null] = onReleases.size === 1 ? onReleases : [];
  return release;
};

/**
 * What `client` runs now, for a rollback to take it back to: the release
 * every Worker was seen running (`runningRelease`), or when they're split
 * the last whole release its operation carries forward, with its secrets
 * generation and the shared secrets its operation last delivered.
 */
export const previousRunOf = (client: TargetClient): PreviousRun => ({
  // What every Worker was seen running, never how its operation's last
  // run ended. Split between releases (a change that stopped part way),
  // the last whole release it ran is carried forward: the way back.
  release:
    runningRelease(client) ?? client.operation?.previousReleaseId ?? null,
  generation: client.generation,
  versions: {},
  shared: client.operation?.shared ?? {},
});

/** Parses a target's recorded `previous`; null when it has none. */
export const parsePrevious = (previous: string | null): PreviousRun | null => {
  if (previous === null) {
    return null;
  }
  const parsed = previousRunSchema.safeParse(JSON.parse(previous));
  return parsed.success ? parsed.data : null;
};
