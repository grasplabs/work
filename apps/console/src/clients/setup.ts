/**
 * A client's own Grasp as the console runs it, read for the admin's Setup
 * section (src/admin/setup.tsx): its provisioning, its account and what
 * the console last made live there, every deploy, the releases it can
 * get and the rollout that last reached it, how its people sign in, its
 * secrets, and what staff did to it by hand. All of it is what the
 * console itself recorded in D1, read with the client pages' own queries
 * where they have one; nothing here asks its account or its core.
 */
import { desc, eq, sql } from "drizzle-orm";

import { consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import {
  clientDeploys,
  clients,
  clientWorkers,
  rollouts,
  rolloutTargets,
} from "../db/schema.ts";
import { clientGatewayId } from "../deploy/core-config.ts";
import type { ClientSignInRecord } from "../deploy/core-config.ts";
import type { DeployKind } from "../deploy/deploy.ts";
import { importedManifest } from "../deploy/release.ts";
import { bucketNames, databaseNames } from "../deploy/resources.ts";
import { getProvisioning } from "../provision/queries.ts";
import type { ProvisioningView } from "../provision/queries.ts";
import { listReleases } from "../releases/queries.ts";
import { clientHistory, clientSettings } from "./queries.ts";

/** How many of a client's deploys the section lists: the latest. */
export const setupDeployLimit = 20;

/** How many releases the section lists: the newest. */
export const setupReleaseLimit = 10;

/** One of a client's deploys. */
export interface SetupDeploy {
  id: string;
  releaseId: string;
  kind: DeployKind;
  status: (typeof clientDeploys.status.enumValues)[number];
  /** The last step that finished; null before the first. */
  step: string | null;
  /** Why it failed, as a code. */
  error: string | null;
  startedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A Worker the console deployed to the client, and what it last made live there. */
export interface SetupWorker {
  worker: "core" | "connect";
  scriptName: string;
  releaseId: string | null;
  versionId: string | null;
  deployedAt: Date | null;
}

/** What staff did to the client by hand, as the audit log recorded it. */
export interface SetupEvent {
  id: string;
  at: Date;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
}

/** A client's own Grasp, as the Setup section shows it. */
export interface ClientSetup {
  provisioning: ProvisioningView;
  account: {
    /** The account's workers.dev subdomain; null before the first deploy. */
    workersSubdomain: string | null;
    generation: number;
    rotatedAt: Date | null;
    rotationLiveAt: Date | null;
    configChangedAt: Date | null;
  } | null;
  /** How its people sign in, as its record has it; null without one. */
  signIn: ClientSignInRecord | null;
  /** Whether a `SIGN_IN` setting replaces that on deploy. */
  signInOverridden: boolean;
  /** Whether a change to what a deploy sets on its core waits for its next deploy. */
  configPending: boolean;
  /** The newest first: its latest `setupDeployLimit`. */
  deploys: SetupDeploy[];
  /** Whether it has older deploys than those. */
  moreDeploys: boolean;
  workers: SetupWorker[];
  /**
   * What the release it runs keeps in its account: its databases and
   * buckets as that release's manifest names them, and its AI Gateway.
   * Null before anything is live there.
   */
  resources: { databases: string[]; buckets: string[]; gateway: string } | null;
  /** The newest imported releases, newest first: the latest `setupReleaseLimit`. */
  releases: { id: string; notes: string; builtAt: Date }[];
  /** The newest release of all, whether or not it is listed. */
  newestReleaseId: string | null;
  /** Whether the console has older releases than those. */
  moreReleases: boolean;
  /** How many releases came after the one its core runs; null when that can't be told. */
  behind: number | null;
  /** The latest rollout the client was in, and how far it got with it. */
  rollout: {
    id: string;
    kind: (typeof rollouts.kind.enumValues)[number];
    releaseId: string | null;
    status: (typeof rollouts.status.enumValues)[number];
    ring: number;
    target: (typeof rolloutTargets.status.enumValues)[number];
    error: string | null;
  } | null;
  /** What staff did to it by hand, the newest first. */
  done: SetupEvent[];
}

/** What staff do to a client by hand, as its audit log names it. */
const byHand: ReadonlySet<string> = new Set([
  "client.provision_start",
  "client.provision_retry",
  "client.workers_paid",
  "client.ring",
  "client.pin",
  "client.unpin",
  "client.rotate_secrets",
  "client.sign_in",
  "client.apply_settings",
]);

const deploysOf = async (
  db: ConsoleDatabase,
  clientId: string
): Promise<SetupDeploy[]> =>
  await db
    .select({
      id: clientDeploys.id,
      releaseId: clientDeploys.releaseId,
      kind: clientDeploys.kind,
      status: clientDeploys.status,
      step: clientDeploys.step,
      error: clientDeploys.error,
      startedBy: clientDeploys.startedBy,
      createdAt: clientDeploys.createdAt,
      updatedAt: clientDeploys.updatedAt,
    })
    .from(clientDeploys)
    .where(eq(clientDeploys.clientId, clientId))
    // Two deploys of one millisecond in the order they started.
    .orderBy(desc(clientDeploys.createdAt), desc(sql`rowid`))
    // One more than it lists, which says whether there are older ones.
    .limit(setupDeployLimit + 1);

const workersOf = async (
  db: ConsoleDatabase,
  clientId: string
): Promise<SetupWorker[]> => {
  const rows = await db
    .select({
      worker: clientWorkers.worker,
      scriptName: clientWorkers.scriptName,
      releaseId: clientWorkers.releaseId,
      versionId: clientWorkers.versionId,
      deployedAt: clientWorkers.deployedAt,
    })
    .from(clientWorkers)
    .where(eq(clientWorkers.clientId, clientId));
  return rows.toSorted((a, b) => a.worker.localeCompare(b.worker));
};

/** What release `releaseId` keeps in an account, as its manifest names it. */
const resourcesOf = async (
  db: ConsoleDatabase,
  releaseId: string | null
): Promise<ClientSetup["resources"]> => {
  const manifest =
    releaseId === null ? null : await importedManifest(db, releaseId);
  if (manifest === null) {
    return null;
  }
  return {
    databases: databaseNames(manifest),
    buckets: bucketNames(manifest),
    gateway: clientGatewayId,
  };
};

/** The latest rollout client `clientId` was in, and its part in it. */
const rolloutOf = async (
  db: ConsoleDatabase,
  clientId: string
): Promise<ClientSetup["rollout"]> => {
  const [latest] = await db
    .select({
      id: rollouts.id,
      kind: rollouts.kind,
      releaseId: rollouts.releaseId,
      status: rollouts.status,
      ring: rollouts.ring,
      target: rolloutTargets.status,
      error: rolloutTargets.error,
    })
    .from(rolloutTargets)
    .innerJoin(rollouts, eq(rollouts.id, rolloutTargets.rolloutId))
    .where(eq(rolloutTargets.clientId, clientId))
    .orderBy(desc(rollouts.createdAt))
    .limit(1);
  return latest ?? null;
};

/**
 * How many releases came after `runs`, the one a client runs, in the
 * order the release list has them (`listReleases`): null when it runs none, or one the console doesn't have.
 */
const behindOf = async (
  db: ConsoleDatabase,
  runs: string | null
): Promise<number | null> => {
  if (runs === null) {
    return null;
  }
  const [row] = await db.all<{ behind: number | null }>(sql`
    SELECT (SELECT count(*) FROM releases newer WHERE newer.built_at > own.built_at
      OR (newer.built_at = own.built_at AND newer.id > own.id)) AS behind
    FROM releases own WHERE own.id = ${runs}`);
  return row?.behind ?? null;
};

/** Client `clientId`'s own Grasp, or null when the console has neither its record nor a run. */
export const getClientSetup = async (
  env: Env,
  clientId: string
): Promise<ClientSetup | null> => {
  const provisioning = await getProvisioning(env, clientId);
  if (provisioning === null) {
    return null;
  }
  const db = consoleDatabase(env.DB);
  const [account] = await db
    .select({
      workersSubdomain: clients.workersSubdomain,
      generation: clients.generation,
      rotatedAt: clients.rotatedAt,
      rotationLiveAt: clients.rotationLiveAt,
      configChangedAt: clients.configChangedAt,
    })
    .from(clients)
    .where(eq(clients.id, clientId));
  const [settings, deploys, workers, listed, rollout, history] =
    await Promise.all([
      clientSettings(db, clientId),
      deploysOf(db, clientId),
      workersOf(db, clientId),
      listReleases(db),
      rolloutOf(db, clientId),
      clientHistory(db, clientId),
    ]);
  // Core's release is the one its people meet.
  const runs =
    workers.find(({ worker }) => worker === "core")?.releaseId ?? null;
  return {
    provisioning,
    account: account ?? null,
    signIn: settings?.signIn ?? null,
    signInOverridden: settings?.signInOverridden ?? false,
    configPending: settings?.configPending ?? false,
    deploys: deploys.slice(0, setupDeployLimit),
    moreDeploys: deploys.length > setupDeployLimit,
    workers,
    resources: await resourcesOf(db, runs),
    releases: listed.releases
      .slice(0, setupReleaseLimit)
      .map(({ id, notes, builtAt }) => ({ id, notes, builtAt })),
    newestReleaseId: listed.releases[0]?.id ?? null,
    moreReleases:
      listed.releases.length > setupReleaseLimit || listed.older !== null,
    behind: await behindOf(db, runs),
    rollout,
    done: history.filter(
      ({ actor, action }) => actor !== "system" && byHand.has(action)
    ),
  };
};
