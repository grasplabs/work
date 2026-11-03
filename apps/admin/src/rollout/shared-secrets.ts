import { log } from "@grasp-os/shared/log";
/**
 * Shared secrets as desired state, and which old ones can be revoked.
 *
 * What clients should run is what Secrets Store holds now: Deploy
 * platform copies a rotated shared secret in, and the reconciler
 * (src/rollout/reconciler.ts) deploys again every active client whose
 * Workers were given anything else (`desiredShared`, src/rollout/desired.ts),
 * as it deploys a release, 25 at a time per channel and stopping a
 * channel at its first failure. Nothing is saved of the store: a deploy
 * delivers its values as they are, so one that succeeds settles the
 * client, whatever the store held before.
 *
 * Each version a deploy uploads records a keyed fingerprint of each shared
 * secret it runs with, by name (`sharedSecretPrints`: they tell nothing of
 * the values). A secret's old value can be revoked once every active
 * client runs the store's value on every Worker of its release that holds
 * the secret, read live from its account as drift reads it
 * (src/rollout/drift.ts): a Worker that's unrecorded, split, unreadable,
 * or live on a version without fingerprints is behind on every secret it
 * holds, and so is a client whose account doesn't answer in time. No
 * client may still be being provisioned: it may hold the store's earlier
 * values for the Workers it has yet to upload, so it counts as behind on
 * every secret, unread.
 *
 * Read on demand: it reads every active client's account, a few at a
 * time, each within a deadline (src/live-reads.ts).
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import {
  clientPlacements,
  clientProvisions,
  clients,
  clientWorkers,
} from "../db/schema.ts";
import { deploySecrets, MissingStoreSecretError } from "../deploy/context.ts";
import { sharedSecretPrints } from "../deploy/secrets.ts";
import type { DeploySecrets } from "../deploy/secrets.ts";
import { defaultLiveReadLimits, eachLimited, within } from "../live-reads.ts";
import type { LiveReadLimits } from "../live-reads.ts";
import type { SharedByWorker } from "./desired.ts";
import { driftOf } from "./drift.ts";
import type { ClientDrift } from "./drift.ts";
import { deliveredShared } from "./targets.ts";

/** Shared-secret fingerprints, by secret name. */
export type SharedPrints = Record<string, string>;

/** A Worker the admin deploys, as `client_workers` names it. */
const workerSchema = z.enum(clientWorkers.worker.enumValues);

/** Client ids in order. */
const byId = (a: string, b: string): number => a.localeCompare(b);

/**
 * The fingerprint of each shared secret in `secrets`, by name: a secret
 * two apps share has one value, so one fingerprint.
 */
export const storePrints = async (
  secrets: Pick<DeploySecrets, "clientKey" | "shared">
): Promise<SharedPrints> => {
  const byApp = await Promise.all(
    Object.keys(secrets.shared).map(
      async (app) => await sharedSecretPrints(secrets, app)
    )
  );
  return Object.fromEntries(byApp.flatMap((prints) => Object.entries(prints)));
};

/** The shared secrets each app holds, by app, from `secrets`. */
const holdersOf = (
  secrets: Pick<DeploySecrets, "shared">
): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(secrets.shared).map(([app, values]) => [
      app,
      Object.keys(values),
    ])
  );

/**
 * The shared-secret fingerprints client `clientId`'s operation delivered
 * to `app`, by name, while `app` runs `version`, the one its operation
 * recorded live; null when it runs another, or none are on record.
 */
export const recordedShared = async (
  db: AdminDatabase,
  clientId: string,
  app: string,
  version: string
): Promise<SharedPrints | null> => {
  const worker = workerSchema.safeParse(app);
  if (!worker.success) {
    return null;
  }
  const row = await db
    .select({
      versionId: clientWorkers.versionId,
      progress: clientProvisions.progress,
      status: clientProvisions.status,
    })
    .from(clientWorkers)
    .innerJoin(
      clientProvisions,
      eq(clientProvisions.clientId, clientWorkers.clientId)
    )
    .where(
      and(
        eq(clientWorkers.clientId, clientId),
        eq(clientWorkers.worker, worker.data)
      )
    )
    .get();
  if (row === undefined || row.status !== "done") {
    return null;
  }
  if (row.versionId !== version) {
    return null;
  }
  return deliveredShared(row.progress)[app] ?? null;
};

/**
 * For each shared secret, whether the client whose drift is `drift` (read
 * live, `driftOf`) runs `expected`'s value on every Worker of its release
 * that holds it (`holders`), by name. A Worker that's unrecorded, split,
 * unreadable, not read at all, or live on a version without fingerprints
 * runs none of the secrets it holds; a client with no Worker read runs
 * none at all.
 */
const liveMatches = async (
  db: AdminDatabase,
  drift: ClientDrift | null,
  holders: Readonly<Record<string, readonly string[]>>,
  expected: SharedPrints
): Promise<Map<string, boolean>> => {
  const names = [...new Set(Object.values(holders).flat())];
  const matches = new Map(names.map((name) => [name, true]));
  if (drift === null || drift.workers.length === 0) {
    return new Map(names.map((name) => [name, false]));
  }
  const workers = await Promise.all(
    drift.workers.map(async ({ worker, recorded, live }) => {
      const [only, ...others] = live ?? [];
      const serving =
        recorded === null ||
        only === undefined ||
        others.length > 0 ||
        only.percentage !== 100
          ? null
          : only.version_id;
      return {
        held: holders[worker] ?? [],
        prints:
          serving === null
            ? null
            : await recordedShared(db, drift.clientId, worker, serving),
      };
    })
  );
  // A Worker drift doesn't read (in a namespace, one core names
  // no version for) runs none: what its operation delivered doesn't say
  // what it runs now, and a secret it still runs must never read as
  // revocable.
  const read = new Set(drift.workers.map(({ worker }) => worker));
  const unread = Object.keys(holders)
    .filter((app) => !read.has(app))
    .map((app) => ({ held: holders[app] ?? [], prints: null }));
  for (const { held, prints } of [...workers, ...unread]) {
    for (const name of held) {
      const runs = prints !== null && prints[name] === expected[name];
      matches.set(name, (matches.get(name) ?? true) && runs);
    }
  }
  return matches;
};

/**
 * What Secrets Store holds, as clients are checked against it: the shared
 * secrets each app holds, and their fingerprints (`storePrints`). Worked
 * out once for however many clients are checked.
 */
export interface StoreCheck {
  holders: Record<string, string[]>;
  expected: SharedPrints;
}

/** What `secrets`' store holds, to check clients against (`sharedSecretsStatus`). */
export const storeCheck = async (
  secrets: Pick<DeploySecrets, "clientKey" | "shared">
): Promise<StoreCheck> => ({
  holders: holdersOf(secrets),
  expected: await storePrints(secrets),
});

/**
 * Whether the client whose drift is `drift` (read live, `driftOf`) runs
 * every shared secret in the store now (`check`), on every Worker holding
 * it; null when that can't be told: its drift is unknown (nothing
 * recorded, or its account didn't answer), or a Worker's live versions
 * weren't read, or drift doesn't read a Worker holding one (in a
 * namespace, one core names no version for). Only what was read
 * and differs is behind.
 */
export const sharedSecretsStatus = async (
  db: AdminDatabase,
  drift: ClientDrift | null,
  check: StoreCheck
): Promise<boolean | null> => {
  const read = new Set(drift?.workers.map(({ worker }) => worker));
  if (
    drift === null ||
    drift.state === "unknown" ||
    drift.workers.some(({ live }) => live === null) ||
    Object.keys(check.holders).some((app) => !read.has(app))
  ) {
    return null;
  }
  const matches = await liveMatches(db, drift, check.holders, check.expected);
  return [...matches.values()].every(Boolean);
};

/**
 * What a deploy would give each Worker now: the fingerprint of each
 * shared secret Secrets Store holds for it, by Worker, then name. Null
 * while the store can't be read, as a deploy can't run then either.
 */
export const desiredShared = async (
  env: Env
): Promise<SharedByWorker | null> => {
  let secrets: DeploySecrets;
  try {
    secrets = await deploySecrets(env);
  } catch (error) {
    if (error instanceof MissingStoreSecretError) {
      log.warn("secrets.store_unreadable", { secret: error.secret });
      return null;
    }
    throw error;
  }
  return Object.fromEntries(
    await Promise.all(
      Object.keys(secrets.shared).map(
        async (app) => [app, await sharedSecretPrints(secrets, app)] as const
      )
    )
  );
};

/** Which old shared secrets can be revoked, and why not the rest. */
export interface RevocationCheck {
  /**
   * Secrets every client runs Secrets Store's value of, by name: an older
   * value of one is no longer run anywhere.
   */
  revocable: string[];
  /**
   * Per secret in the store, the clients not known to run its value:
   * active ones that don't, read live, or whose account didn't answer in
   * time, and every client still being provisioned.
   */
  behind: Record<string, string[]>;
}

/** What a revocation check can't be made for. */
export type RevocationRefusal = "store_unreadable";

/**
 * The clients still being provisioned: what a revocation check counts as
 * behind without reading them, with or without a Worker on record.
 */
const provisioningClients = async (db: AdminDatabase): Promise<string[]> => {
  const rows = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.status, "provisioning"));
  return rows.map(({ id }) => id);
};

/**
 * Which shared secrets' old values can be revoked (`RevocationCheck`); a
 * refusal while Secrets Store can't be read. Active clients are read
 * `limits.concurrency` at a time, each within `limits.rowDeadlineMs`; one
 * that doesn't answer by then is behind on every secret.
 */
export const checkRevocation = async (
  env: Env,
  limits: LiveReadLimits = defaultLiveReadLimits
): Promise<RevocationCheck | RevocationRefusal> => {
  const db = adminDatabase(env.DB);
  let secrets: DeploySecrets;
  try {
    secrets = await deploySecrets(env);
  } catch (error) {
    if (error instanceof MissingStoreSecretError) {
      return "store_unreadable";
    }
    throw error;
  }
  const now = await storePrints(secrets);
  const holders = holdersOf(secrets);
  // Every active placed client: what its operation delivered is read
  // back from where it runs.
  const active = await db
    .select({ id: clients.id })
    .from(clients)
    .innerJoin(clientPlacements, eq(clientPlacements.clientId, clients.id))
    .where(eq(clients.status, "active"));
  const live = await eachLimited(
    active,
    limits.concurrency,
    async ({ id }) =>
      [
        id,
        await within(
          limits.rowDeadlineMs,
          async (signal) =>
            await liveMatches(
              db,
              await driftOf(db, id, {
                dispatcher: env.DISPATCHER,
                secrets,
                signal,
              }),
              holders,
              now
            ),
          // No answer in time: it runs none of them, as far as is known.
          await liveMatches(db, null, holders, now)
        ),
      ] as const
  );
  const provisioning = await provisioningClients(db);
  const names = Object.keys(now).toSorted();
  const behind = Object.fromEntries(
    names.map((name) => [
      name,
      [
        ...live
          .filter(([, matches]) => matches.get(name) !== true)
          .map(([id]) => id),
        ...provisioning,
      ].toSorted(byId),
    ])
  );
  return {
    revocable: names.filter((name) => (behind[name] ?? []).length === 0),
    behind,
  };
};
