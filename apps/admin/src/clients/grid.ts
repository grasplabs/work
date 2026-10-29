/**
 * The client grid: every client with what the admin recorded of it
 * (release, ring, last deploy), read from D1 and shown at once, and, for
 * each active one, what its destination shows now: drift, whether it runs
 * the shared secrets in Secrets Store, whether the router reaches its
 * core, and where its onboarding stands (onboarding.ts).
 *
 * The live columns are read after the page shows (`gridLive`): a few
 * clients at a time, each within a deadline, with what every client needs
 * (Secrets Store, release manifests) read once. Each client's answer is kept for a minute, so reloading the
 * page doesn't read the accounts again. Whatever doesn't answer in time
 * shows as unknown, and is read again the next time: only an answer with
 * nothing unknown in it is kept. Nothing live fails the grid.
 */
import { log } from "@grasp-os/shared/log";
import { onboardingSummarySchema } from "@grasp-os/shared/onboarding-summary";
import { deriveRouterSecret, routerTargetOf } from "@grasp-os/shared/router";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { cloudflareApi } from "../cloudflare/api.ts";
import type { CloudflareApi } from "../cloudflare/api.ts";
import { adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import { clientProvisions, clients, clientWorkers } from "../db/schema.ts";
import {
  clientDomain,
  deployerToken,
  deploySecrets,
  MissingStoreSecretError,
} from "../deploy/context.ts";
import { errorCode } from "../deploy/errors.ts";
import { importedManifest } from "../deploy/release.ts";
import { answeringVersion, mappedRoute } from "../deploy/router.ts";
import type { RouterHosts } from "../deploy/router.ts";
import { clientAuthSecret } from "../deploy/secrets.ts";
import type { DeploySecrets } from "../deploy/secrets.ts";
import { defaultLiveReadLimits, eachLimited, within } from "../live-reads.ts";
import type { LiveReadLimits } from "../live-reads.ts";
import { driftOf } from "../rollout/drift.ts";
import type { ManifestOf } from "../rollout/drift.ts";
import { sharedSecretsStatus, storeCheck } from "../rollout/shared-secrets.ts";
import type { StoreCheck } from "../rollout/shared-secrets.ts";
import { coreAddressOf } from "./core-address.ts";
import type { ClientDispatcher, CoreAddress } from "./core-address.ts";
import { onboardingSummaryOf } from "./onboarding.ts";
import type { OnboardingCell } from "./onboarding.ts";

/** Whether the router reaches a client's core, as its health check answers. */
export type Reach = "reachable" | "unreachable" | "no_route" | "unknown";

const driftStates = [
  "in_sync",
  "drifted",
  "split",
  "off_pin",
  "unknown",
] as const;

/** What a client's account shows now, read after the grid shows. */
const liveStatusSchema = z.object({
  drift: z.enum(driftStates),
  /** Whether it runs the shared secrets in Secrets Store now; null when that can't be told. */
  sharedSecretsCurrent: z.boolean().nullable(),
  reach: z.enum(["reachable", "unreachable", "no_route", "unknown"]),
  /** Its onboarding, numbers only (`OnboardingCell`); null when unknown. */
  onboarding: z
    .union([onboardingSummarySchema, z.literal("unreachable")])
    .nullable(),
});
export type LiveStatus = z.infer<typeof liveStatusSchema>;

/** A client as the grid shows it at once, from what the admin recorded. */
export interface GridRow {
  id: string;
  name: string;
  status: "provisioning" | "active" | "offboarded";
  ring: number;
  /** `<id>.<domain>`; null while the admin has no domain. */
  hostname: string | null;
  /** The release the admin made live on every Worker; null when none, or they differ. */
  release: string | null;
  pinnedReleaseId: string | null;
  /**
   * Its operation's latest run (src/hosting/operation.ts): the release, how
   * it ended, and when it last changed; null before it has one.
   */
  lastDeploy: {
    releaseId: string;
    status: "running" | "done" | "failed";
    at: Date;
  } | null;
}

/** How long a client's health check, or another request to its core, may take. */
export const healthTimeoutMs = 5000;

/**
 * How reading live columns may go: how many clients at once and how long
 * one client may take all told (`LiveReadLimits`), and whether answers are
 * kept a minute.
 */
export interface LiveOptions extends LiveReadLimits {
  cache: boolean;
}

export const defaultLiveOptions: LiveOptions = {
  ...defaultLiveReadLimits,
  cache: true,
};

/** The cache clients' live answers are kept in. */
const cacheName = "grid-live";

/** How long a client's live answer is kept. */
const cacheSeconds = 60;

/** Where a client's live answer is kept: a URL only the admin uses. */
const cacheKey = (clientId: string): string =>
  `https://grid-live.admin.invalid/${encodeURIComponent(clientId)}`;

/** Every column unknown: a client whose reads failed or ran out of time. */
const unknownStatus: LiveStatus = {
  drift: "unknown",
  sharedSecretsCurrent: null,
  reach: "unknown",
  onboarding: null,
};

/**
 * Whether every column of `live` was read. Only such an answer is kept:
 * an unknown is an account, the store or the analytics not answering, and
 * kept, it would still show as unknown a minute after they answer again.
 */
const allKnown = (live: LiveStatus): boolean =>
  live.drift !== "unknown" &&
  live.sharedSecretsCurrent !== null &&
  live.reach !== "unknown" &&
  live.onboarding !== null;

/**
 * Every client, as the admin recorded it, by id: two queries, whatever
 * their number, with no list of ids to bind (D1 binds at most 100).
 */
const recordedClients = async (db: AdminDatabase) => {
  const rows = await db
    .select({
      id: clients.id,
      name: clients.name,
      status: clients.status,
      ring: clients.ring,
      pinnedReleaseId: clients.pinnedReleaseId,
      lastDeploy: {
        releaseId: clientProvisions.releaseId,
        status: clientProvisions.status,
        at: clientProvisions.updatedAt,
      },
    })
    .from(clients)
    // Its one operation, unique by client.
    .leftJoin(clientProvisions, eq(clientProvisions.clientId, clients.id))
    .orderBy(asc(clients.id));
  // Two rows a client, core's and connect's: as many as the clients.
  const workers = await db
    .select({
      clientId: clientWorkers.clientId,
      releaseId: clientWorkers.releaseId,
    })
    .from(clientWorkers);
  const releasesOf = new Map<string, Set<string | null>>();
  for (const { clientId, releaseId } of workers) {
    const releases = releasesOf.get(clientId) ?? new Set();
    releases.add(releaseId);
    releasesOf.set(clientId, releases);
  }
  return rows.map((row) => {
    const releases = releasesOf.get(row.id) ?? new Set();
    const [only = null] = releases.size === 1 ? releases : [];
    return { ...row, release: only };
  });
};

/**
 * What the router knows of client `clientId`'s core: where it answers (its
 * script through `dispatcher`, or its origin: `coreAddressOf`), and the
 * secret the router sends. A script without a dispatcher to reach it by is
 * `unknown`, never another client's core.
 */
export const routeOf = async (
  hosts: RouterHosts,
  routerKey: string | null,
  clientId: string,
  hostname: string | null,
  dispatcher: ClientDispatcher | undefined
): Promise<
  | { core: CoreAddress; generation: number; secret: string }
  | "no_route"
  | "unknown"
> => {
  if (hostname === null || routerKey === null) {
    return "unknown";
  }
  const route = await mappedRoute(hosts, hostname);
  if (route === null || route.clientId !== clientId) {
    return "no_route";
  }
  const core = coreAddressOf(routerTargetOf(route), hostname, dispatcher);
  if (core === undefined) {
    return "unknown";
  }
  return {
    core,
    generation: route.generation,
    secret: await deriveRouterSecret(routerKey, clientId, route.generation),
  };
};

/**
 * Whether the router reaches client `clientId`'s core by `route`: core's
 * health check answering a request with the router secret the router
 * would send.
 */
const reachOf = async (
  route: Awaited<ReturnType<typeof routeOf>>,
  signal: AbortSignal
): Promise<Reach> => {
  if (typeof route === "string") {
    return route;
  }
  // Its own deadline starts as it's sent; the row's stops it too.
  const fetchCore: typeof fetch = async (input, init) =>
    await route.core.fetch(input, {
      ...init,
      signal:
        init?.signal === undefined || init.signal === null
          ? signal
          : AbortSignal.any([init.signal, signal]),
    });
  const version = await answeringVersion(
    fetchCore,
    route.core.origin,
    route.secret,
    healthTimeoutMs
  );
  return version === undefined ? "unreachable" : "reachable";
};

/** Client `clientId`'s onboarding by `route`, as its core answers the admin. */
const onboardingOf = async (
  route: Awaited<ReturnType<typeof routeOf>>,
  secrets: DeploySecrets | null,
  clientId: string,
  signal: AbortSignal
): Promise<OnboardingCell> => {
  if (route === "no_route") {
    return "unreachable";
  }
  if (route === "unknown" || secrets === null) {
    return null;
  }
  return await onboardingSummaryOf({
    core: route.core,
    routerSecret: route.secret,
    authSecret: await clientAuthSecret(secrets, clientId, route.generation),
    signal: AbortSignal.any([signal, AbortSignal.timeout(healthTimeoutMs)]),
  });
};

/** What reading a client's live status takes, read once for every client: each part may be missing. */
interface LiveSources {
  env: Env;
  db: AdminDatabase;
  /**
   * The deployer's API, its calls stopped by `signal`; null when its token
   * can't be read.
   */
  apiFor: ((signal: AbortSignal) => CloudflareApi) | null;
  /** The router key; null when Secrets Store doesn't have it. */
  routerKey: string | null;
  /** The keys clients' secrets derive from; null when Secrets Store doesn't have them. */
  secrets: DeploySecrets | null;
  /** What Secrets Store holds, to check clients against; null when it can't be read. */
  store: StoreCheck | null;
  /** Release manifests, each read once. */
  manifestOf: ManifestOf;
}

/** What `task` answers, or `fallback` when it throws, logged as `event`. */
const orElse = async <T>(
  task: () => Promise<T>,
  fallback: T,
  event: string,
  clientId: string
): Promise<T> => {
  try {
    return await task();
  } catch (error) {
    log.warn(event, { clientId, error: errorCode(error) });
    return fallback;
  }
};

/**
 * A client's live status, never throwing: what can't be read is unknown.
 * Its requests stop when `signal` aborts.
 */
const liveOf = async (
  { env, db, apiFor, routerKey, secrets, store }: LiveSources,
  row: { id: string; hostname: string | null },
  signal: AbortSignal
): Promise<LiveStatus> => {
  const drift =
    apiFor === null
      ? null
      : await orElse(
          async () =>
            await driftOf(
              apiFor(signal),
              db,
              row.id,
              secrets === null ? undefined : { fetch, secrets }
            ),
          null,
          "grid.drift_unread",
          row.id
        );
  const route = await orElse(
    async () =>
      await routeOf(
        env.ROUTER_HOSTS,
        routerKey,
        row.id,
        row.hostname,
        env.DISPATCHER
      ),
    "unknown" as const,
    "grid.route_unread",
    row.id
  );
  const [sharedSecretsCurrent, reach, onboarding] = await Promise.all([
    store === null
      ? null
      : orElse(
          async () => await sharedSecretsStatus(db, drift, store),
          null,
          "grid.secrets_unread",
          row.id
        ),
    orElse(
      async () => await reachOf(route, signal),
      "unknown" as const,
      "grid.health_unread",
      row.id
    ),
    orElse(
      async () => await onboardingOf(route, secrets, row.id, signal),
      null,
      "grid.onboarding_unread",
      row.id
    ),
  ]);
  return {
    drift: drift?.state ?? "unknown",
    sharedSecretsCurrent,
    reach,
    onboarding,
  };
};

/** What `read` answers, or null when a secret it reads isn't in Secrets Store. */
export const ifStored = async <T>(
  read: () => Promise<T>
): Promise<T | null> => {
  try {
    return await read();
  } catch (error) {
    if (error instanceof MissingStoreSecretError) {
      return null;
    }
    throw error;
  }
};

/**
 * Client `clientId`'s live answer kept within the last minute, if any. A
 * cache that fails to answer is a miss, and so is a kept answer with
 * anything unknown in it (`allKnown`; none is kept now, but one kept
 * before that rule may still be there): the answer is read again.
 */
const cached = async (clientId: string): Promise<LiveStatus | undefined> => {
  try {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(cacheKey(clientId));
    if (hit === undefined) {
      return undefined;
    }
    const parsed = liveStatusSchema.safeParse(await hit.json());
    return parsed.success && allKnown(parsed.data) ? parsed.data : undefined;
  } catch (error) {
    log.warn("grid.cache_unread", { clientId, error: errorCode(error) });
    return undefined;
  }
};

/**
 * Keeps client `clientId`'s live answer for a minute: one with nothing
 * unknown in it (`allKnown`). A cache that fails to keep it is logged,
 * and the answer stands.
 */
const keep = async (clientId: string, live: LiveStatus): Promise<void> => {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(
      cacheKey(clientId),
      Response.json(live, {
        headers: { "cache-control": `max-age=${cacheSeconds}` },
      })
    );
  } catch (error) {
    log.warn("grid.cache_unkept", { clientId, error: errorCode(error) });
  }
};

/**
 * The deployer's API, its calls stopped by the signal each is made with,
 * from its token read once; null when the token can't be read.
 */
const deployerApiFor = async (
  env: Env,
  waitBudgetMs: number
): Promise<((signal: AbortSignal) => CloudflareApi) | null> => {
  const token = await ifStored(async () => await deployerToken(env));
  return token === null
    ? null
    : (signal) => cloudflareApi({ token, waitBudgetMs, signal });
};

/** Every client, as the admin recorded it, for the grid to show at once. */
export const clientGrid = async (env: Env): Promise<GridRow[]> => {
  const domain = clientDomain(env);
  const recorded = await recordedClients(adminDatabase(env.DB));
  return recorded.map((row) => ({
    ...row,
    hostname: domain === null ? null : `${row.id}.${domain}`,
  }));
};

/**
 * Each active client's live status, by id: kept answers
 * from the last minute, and the rest read `options.concurrency` clients
 * at a time, each within `options.rowDeadlineMs`. An answer with anything
 * unknown in it isn't kept, so the next call reads that client again.
 * With `only`, that one client alone, for its own page in the admin.
 */
export const gridLive = async (
  env: Env,
  options: LiveOptions = defaultLiveOptions,
  only?: string
): Promise<Record<string, LiveStatus>> => {
  const db = adminDatabase(env.DB);
  const grid = await clientGrid(env);
  const active = grid.filter(
    ({ id, status }) =>
      status === "active" && (only === undefined || id === only)
  );
  const answers = new Map<string, LiveStatus>();
  if (options.cache) {
    const kept = await Promise.all(
      active.map(async ({ id }) => [id, await cached(id)] as const)
    );
    for (const [id, live] of kept) {
      if (live !== undefined) {
        answers.set(id, live);
      }
    }
  }
  const toRead = active.filter(({ id }) => !answers.has(id));
  if (toRead.length > 0) {
    // The token is read once, here: every client's reads make their API
    // from it, each stopped by its own deadline.
    const apiFor = await deployerApiFor(env, options.waitBudgetMs);
    const secrets = await ifStored(
      async (): Promise<DeploySecrets> => await deploySecrets(env)
    );
    const manifests = new Map<string, ReturnType<ManifestOf>>();
    const sources: LiveSources = {
      env,
      db,
      apiFor,
      routerKey: secrets?.routerKey ?? null,
      secrets,
      store: secrets === null ? null : await storeCheck(secrets),
      manifestOf: async (id) => {
        const known = manifests.get(id) ?? importedManifest(db, id);
        manifests.set(id, known);
        return await known;
      },
    };
    const read = await eachLimited(
      toRead,
      options.concurrency,
      async (row) =>
        [
          row.id,
          await within(
            options.rowDeadlineMs,
            async (signal) => await liveOf(sources, row, signal),
            unknownStatus
          ),
        ] as const
    );
    for (const [id, live] of read) {
      answers.set(id, live);
    }
    if (options.cache) {
      await Promise.all(
        read
          .filter(([, live]) => allKnown(live))
          .map(async ([id, live]) => {
            await keep(id, live);
          })
      );
    }
  }
  return Object.fromEntries(answers);
};
