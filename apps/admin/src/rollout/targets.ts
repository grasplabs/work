/**
 * Reading a client against its target (src/rollout/desired.ts): the
 * release each channel points at, the one a client should run, and what
 * it runs now, as a deploy, an apply and provisioning read them. Apart
 * from the reconciler, so the hosting code imports it without it.
 */
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { AdminDatabase } from "../db/act.ts";
import {
  channels,
  clientProvisions,
  clients,
  clientWorkers,
} from "../db/schema.ts";
import type { Channel } from "../db/schema.ts";
import { targetOf } from "./desired.ts";
import type { ChannelReleases } from "./desired.ts";

/** The release each channel points at now. */
export const channelReleases = async (
  db: AdminDatabase
): Promise<ChannelReleases> => {
  const rows = await db
    .select({ id: channels.id, releaseId: channels.releaseId })
    .from(channels);
  const of = (channel: Channel) =>
    rows.find(({ id }) => id === channel)?.releaseId ?? null;
  return { edge: of("edge"), beta: of("beta"), stable: of("stable") };
};

/**
 * The release client `clientId` should run (`targetOf`), with its channel;
 * undefined when there's no such client.
 */
export const targetReleaseOf = async (
  db: AdminDatabase,
  clientId: string
): Promise<{ channel: Channel; releaseId: string | null } | undefined> => {
  const client = await db
    .select({
      channel: clients.channel,
      pinnedReleaseId: clients.pinnedReleaseId,
    })
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();
  if (client === undefined) {
    return undefined;
  }
  return {
    channel: client.channel,
    releaseId: targetOf(client, await channelReleases(db)),
  };
};

/** A client as a deploy or an apply reads it. */
export interface TargetClient {
  id: string;
  status: "provisioning" | "active" | "offboarded";
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
  /** The Workers the admin deployed to it, with the release it last made live on each. */
  workers: { worker: string; releaseId: string | null }[];
}

/** When core last went live with the settings as read (`configuredAt`), as SQL. */
const configuredAtOf = sql<
  string | null
>`json_extract(${clientProvisions.progress}, '$.configuredAt')`;

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
      configuredAt: configuredAtOf,
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

/** Client `clientId`, as a deploy or an apply reads it; undefined when it's gone. */
export const targetClient = async (
  db: AdminDatabase,
  clientId: string
): Promise<TargetClient | undefined> => {
  const client = await db
    .select({
      id: clients.id,
      status: clients.status,
      rotatedAt: clients.rotatedAt,
      rotationLiveAt: clients.rotationLiveAt,
      configChangedAt: clients.configChangedAt,
    })
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();
  if (client === undefined) {
    return undefined;
  }
  const { rotatedAt, rotationLiveAt, configChangedAt, ...rest } = client;
  const workers = await db
    .select({
      worker: clientWorkers.worker,
      releaseId: clientWorkers.releaseId,
    })
    .from(clientWorkers)
    .where(eq(clientWorkers.clientId, clientId));
  return {
    ...rest,
    rotationPending: rotatedAt !== null && rotationLiveAt === null,
    configPending: await isConfigPending(db, clientId, configChangedAt),
    workers,
  };
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
