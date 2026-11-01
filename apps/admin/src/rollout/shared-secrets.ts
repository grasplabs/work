/**
 * Rolling shared secrets out, and which old ones can be revoked.
 *
 * Deploy platform copies a rotated shared secret into Secrets Store; staff
 * then roll it out here (`rollOutSecrets`): the store's fingerprints are
 * recorded as the desired state (`rolled_out_secrets`), and the
 * reconciler (src/rollout/reconciler.ts) deploys again every active
 * client whose Workers run other ones, as it deploys a release, 25 at a
 * time per channel and stopping a channel at its first failure.
 *
 * Each version a deploy uploads records a keyed fingerprint of each shared
 * secret it runs with, by name (`sharedSecretPrints`: they tell nothing of
 * the values). A secret's old value can be revoked when all of:
 * - the rollout rotated it: some active client ran another value when
 *   staff rolled it out (none did: the store held what they ran, so
 *   Deploy platform may not have copied a new value in, and there's
 *   nothing to revoke yet);
 * - Secrets Store still holds what it held then;
 * - every active client runs the store's value on every Worker of its
 *   release that holds the secret, read live from its account as drift
 *   reads it (src/rollout/drift.ts): a Worker that's unrecorded, split,
 *   unreadable, or live on a version without fingerprints is behind on
 *   every secret it holds, and so is a client whose account doesn't
 *   answer in time;
 * - no client is still being provisioned: it may hold the store's
 *   earlier values for the Workers it has yet to upload, so it counts as
 *   behind on every secret, unread.
 * A secret the rollout didn't rotate is never called revocable.
 *
 * Read on demand: it reads every active client's account, a few at a
 * time, each within a deadline (src/live-reads.ts).
 */
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { cloudflareApi } from "../cloudflare/api.ts";
import { actIfChanged, adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import {
  clientPlacements,
  clientProvisions,
  clients,
  clientWorkers,
  rolledOutSecrets,
} from "../db/schema.ts";
import {
  clientDomain,
  deployerToken,
  deploySecrets,
  MissingStoreSecretError,
} from "../deploy/context.ts";
import { sharedSecretPrints } from "../deploy/secrets.ts";
import type { DeploySecrets } from "../deploy/secrets.ts";
import { defaultLiveReadLimits, eachLimited, within } from "../live-reads.ts";
import type { LiveReadLimits } from "../live-reads.ts";
import { driftOf } from "./drift.ts";
import type { ClientDrift } from "./drift.ts";
import { RolloutError } from "./errors.ts";
import { deliveredShared } from "./targets.ts";

/** Shared-secret fingerprints, by secret name. */
export type SharedPrints = Record<string, string>;

const sharedPrintsSchema = z.record(z.string(), z.string());

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

/** The fingerprints staff last rolled out, by name; null before any rollout. */
export const rolledOutPrints = async (
  db: AdminDatabase
): Promise<SharedPrints | null> => {
  const row = await db
    .select({ prints: rolledOutSecrets.prints })
    .from(rolledOutSecrets)
    .get();
  if (row === undefined) {
    return null;
  }
  const parsed = sharedPrintsSchema.safeParse(JSON.parse(row.prints));
  return parsed.success ? parsed.data : null;
};

/**
 * The secrets of `prints` some active client runs another value of now,
 * by name, as its operation last delivered them.
 */
const rotatedFrom = async (
  db: AdminDatabase,
  prints: SharedPrints
): Promise<string[]> => {
  const rows = await db
    .select({ progress: clientProvisions.progress })
    .from(clientProvisions)
    .innerJoin(clients, eq(clients.id, clientProvisions.clientId))
    .where(eq(clients.status, "active"));
  const rotated = new Set<string>();
  for (const { progress } of rows) {
    for (const delivered of Object.values(deliveredShared(progress))) {
      for (const [name, print] of Object.entries(delivered)) {
        if (prints[name] !== undefined && prints[name] !== print) {
          rotated.add(name);
        }
      }
    }
  }
  return [...rotated].toSorted();
};

/**
 * Rolls the shared secrets in Secrets Store now out to every active
 * client, as `staff`, audited (`secrets.roll_out`): their fingerprints
 * become what the reconciler deploys. Nothing when they're what was
 * rolled out already. Refused while the admin has no CLIENT_DOMAIN
 * (`domain_not_set`), or Secrets Store is missing a shared secret
 * (`secrets_store_incomplete`).
 */
export const rollOutSecrets = async (env: Env, staff: Staff): Promise<void> => {
  if (clientDomain(env) === null) {
    throw new RolloutError(
      "domain_not_set",
      "Set CLIENT_DOMAIN on the admin before rolling out"
    );
  }
  let secrets: DeploySecrets;
  try {
    secrets = await deploySecrets(env);
  } catch (error) {
    if (error instanceof MissingStoreSecretError) {
      throw new RolloutError("secrets_store_incomplete", error.message);
    }
    throw error;
  }
  const db = adminDatabase(env.DB);
  const prints = await storePrints(secrets);
  const rotated = await rotatedFrom(db, prints);
  const json = JSON.stringify(prints);
  const now = new Date();
  await actIfChanged(
    db,
    staff,
    db
      .insert(rolledOutSecrets)
      .values({
        id: 1,
        prints: json,
        rotated: JSON.stringify(rotated),
        rolledOutBy: staff.email,
        rolledOutAt: now,
      })
      .onConflictDoUpdate({
        target: rolledOutSecrets.id,
        set: {
          prints: json,
          rotated: JSON.stringify(rotated),
          rolledOutBy: staff.email,
          rolledOutAt: now,
        },
        setWhere: ne(rolledOutSecrets.prints, json),
      }),
    { action: "secrets.roll_out", detail: { rotated: rotated.length } }
  );
};

/** Which old shared secrets can be revoked, and why not the rest. */
export interface RevocationCheck {
  /** Secrets whose old values can be revoked, by name: rotated, and everywhere. */
  revocable: string[];
  /** Secrets the last rollout changed for some client, by name. */
  rotated: string[];
  /** Secrets Secrets Store changed since the last rollout, by name. */
  storeChanged: string[];
  /**
   * Per rotated secret, the clients not known to run the store's value:
   * active ones that don't, read live, or whose account didn't answer in
   * time, and every client still being provisioned.
   */
  behind: Record<string, string[]>;
}

/** What a revocation check can't be made for. */
export type RevocationRefusal = "nothing_rolled_out" | "store_unreadable";

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

const rotatedSchema = z.array(z.string());

/**
 * Which of the last rollout's old shared secrets can be revoked
 * (`RevocationCheck`); a refusal before any rollout, or while Secrets
 * Store can't be read. Active clients are read `limits.concurrency` at a
 * time, each within `limits.rowDeadlineMs`; one that doesn't answer by
 * then is behind on every secret.
 */
export const checkRevocation = async (
  env: Env,
  limits: LiveReadLimits = defaultLiveReadLimits
): Promise<RevocationCheck | RevocationRefusal> => {
  const db = adminDatabase(env.DB);
  const row = await db.select().from(rolledOutSecrets).get();
  const started = sharedPrintsSchema.safeParse(
    JSON.parse(row?.prints ?? "null")
  );
  const rotatedNames = rotatedSchema.safeParse(
    JSON.parse(row?.rotated ?? "null")
  );
  if (!started.success || !rotatedNames.success) {
    return "nothing_rolled_out";
  }
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
  const rotated = rotatedNames.data;
  const storeChanged = Object.keys({ ...started.data, ...now }).filter(
    (name) => started.data[name] !== now[name]
  );
  // Every active placed client: what its operation delivered is read
  // back from where it runs.
  const active = await db
    .select({ id: clients.id })
    .from(clients)
    .innerJoin(clientPlacements, eq(clientPlacements.clientId, clients.id))
    .where(eq(clients.status, "active"));
  // Read once: every client's reads make their API from it, each stopped
  // by its own deadline.
  const token = await deployerToken(env);
  const live = await eachLimited(
    active,
    limits.concurrency,
    async ({ id }) =>
      [
        id,
        await within(
          limits.rowDeadlineMs,
          async (signal) => {
            const api = cloudflareApi({
              token,
              waitBudgetMs: limits.waitBudgetMs,
              signal,
            });
            return await liveMatches(
              db,
              await driftOf(api, db, id, {
                dispatcher: env.DISPATCHER,
                secrets,
              }),
              holders,
              now
            );
          },
          // No answer in time: it runs none of them, as far as is known.
          await liveMatches(db, null, holders, now)
        ),
      ] as const
  );
  const provisioning = await provisioningClients(db);
  const behind = Object.fromEntries(
    rotated.map((name) => [
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
    revocable: rotated
      .filter(
        (name) =>
          !storeChanged.includes(name) && (behind[name] ?? []).length === 0
      )
      .toSorted(),
    rotated: rotated.toSorted(),
    storeChanged: storeChanged.toSorted(),
    behind,
  };
};
