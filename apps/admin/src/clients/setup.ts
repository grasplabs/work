/**
 * A client's own Grasp as the admin runs it, read for the admin's Setup
 * section (src/admin/setup.tsx): its provisioning, its account and what
 * the admin last made live there, every deploy, the releases it can
 * get and the rollout that last reached it, how its people sign in, its
 * secrets, and what staff did to it by hand. All of it is what the
 * admin itself recorded in D1, read with the client pages' own queries
 * where they have one; nothing here asks its account or its core.
 */
import { desc, eq, sql } from "drizzle-orm";

import { adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import {
  clients,
  clientSealedSecrets,
  clientWorkers,
  rollouts,
  rolloutTargets,
} from "../db/schema.ts";
import { clientGatewayId } from "../deploy/core-config.ts";
import type { ClientSignInRecord } from "../deploy/core-config.ts";
import { importedManifest } from "../deploy/release.ts";
import { bucketNames, databaseNames } from "../deploy/resources.ts";
import { getProvisioning } from "../provision/queries.ts";
import type { ProvisioningView } from "../provision/queries.ts";
import { listReleases } from "../releases/queries.ts";
import { clientHistory, clientSettings } from "./queries.ts";
import type { HistoryEntry } from "./queries.ts";
import type { TeamsBot } from "./teams-bot.ts";
import type { WatchedSignals } from "./watch-signals.ts";
import { lastWatched } from "./watch.ts";

/** How many releases the section lists: the newest. */
export const setupReleaseLimit = 10;

/** A Worker the admin deployed to the client, and what it last made live there. */
export interface SetupWorker {
  worker: "core" | "connect";
  scriptName: string;
  releaseId: string | null;
  versionId: string | null;
  deployedAt: Date | null;
}

/** A secret staff sealed for the client, as the Setup shows it: never its value. */
export interface SetupSealedSecret {
  name: (typeof clientSealedSecrets.name.enumValues)[number];
  setBy: string;
  setAt: Date;
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
    generation: number;
    rotatedAt: Date | null;
    rotationLiveAt: Date | null;
    configChangedAt: Date | null;
  } | null;
  /** How its people sign in, as its record has it; null without one. */
  signIn: ClientSignInRecord | null;
  /** Whether a `SIGN_IN` setting replaces that on deploy. */
  signInOverridden: boolean;
  /** Its own Teams bot (src/clients/teams-bot.ts); null when it has none. */
  teamsBot: TeamsBot | null;
  /** Whether a change to what a deploy sets on its core waits for its next deploy. */
  configPending: boolean;
  /**
   * The secrets of its own staff sealed for it, such as its Teams bot's
   * (src/deploy/sealed-secrets.ts): who set each and when, never the
   * value, sealed or not, so nothing of it reaches the page.
   */
  sealedSecrets: SetupSealedSecret[];
  /**
   * What the admin's watch last read of how its Stephen fares
   * (src/clients/watch.ts), and when; null before it read any.
   */
  watched: { readAt: Date; signals: WatchedSignals } | null;
  workers: SetupWorker[];
  /**
   * What the release it runs keeps in its account: its databases and
   * buckets as that release's manifest names them, and its AI Gateway.
   * Null before anything is live there.
   */
  resources: { databases: string[]; buckets: string[]; gateway: string } | null;
  /** The newest imported releases, newest first: the latest `setupReleaseLimit`. */
  releases: {
    id: string;
    notes: string;
    builtAt: Date;
    versionMajor: number | null;
    versionMinor: number | null;
  }[];
  /** The newest release of all, whether or not it is listed. */
  newestReleaseId: string | null;
  /** Whether the admin has older releases than those. */
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
  /**
   * Everything the audit log keeps of it, the newest first: staff's
   * changes and its provisioning, deploys and rollouts, the latest
   * `historyLimit` (src/clients/queries.ts).
   */
  history: HistoryEntry[];
}

/** What staff do to a client by hand, as its audit log names it. */
const byHand: ReadonlySet<string> = new Set([
  "client.create",
  "client.place",
  "client.provision_placed",
  "client.ring",
  "client.pin",
  "client.unpin",
  "client.rotate_secrets",
  "client.sign_in",
  "client.sealed_secret",
  "client.teams_bot",
  "client.apply_settings",
  "client.stripe_customer",
  "client.rooms_project",
  "client.attio_company",
]);

const workersOf = async (
  db: AdminDatabase,
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

/** Who set each of client `clientId`'s sealed secrets, and when: only these columns, never `sealed`. */
const sealedSecretsOf = async (
  db: AdminDatabase,
  clientId: string
): Promise<SetupSealedSecret[]> =>
  await db
    .select({
      name: clientSealedSecrets.name,
      setBy: clientSealedSecrets.setBy,
      setAt: clientSealedSecrets.setAt,
    })
    .from(clientSealedSecrets)
    .where(eq(clientSealedSecrets.clientId, clientId))
    .orderBy(clientSealedSecrets.name);

/** What release `releaseId` keeps in an account, as its manifest names it. */
const resourcesOf = async (
  db: AdminDatabase,
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
  db: AdminDatabase,
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
 * order the release list has them (`listReleases`): null when it runs none, or one the admin doesn't have.
 */
const behindOf = async (
  db: AdminDatabase,
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

/** Client `clientId`'s own Grasp, or null when the admin has neither its record nor a run. */
export const getClientSetup = async (
  env: Env,
  clientId: string
): Promise<ClientSetup | null> => {
  const provisioning = await getProvisioning(env, clientId);
  if (provisioning === null) {
    return null;
  }
  const db = adminDatabase(env.DB);
  const [account] = await db
    .select({
      generation: clients.generation,
      rotatedAt: clients.rotatedAt,
      rotationLiveAt: clients.rotationLiveAt,
      configChangedAt: clients.configChangedAt,
    })
    .from(clients)
    .where(eq(clients.id, clientId));
  const [settings, sealedSecrets, workers, listed, rollout, history, watched] =
    await Promise.all([
      clientSettings(db, clientId),
      sealedSecretsOf(db, clientId),
      workersOf(db, clientId),
      listReleases(db),
      rolloutOf(db, clientId),
      clientHistory(db, clientId),
      lastWatched(env, clientId),
    ]);
  // Core's release is the one its people meet.
  const runs =
    workers.find(({ worker }) => worker === "core")?.releaseId ?? null;
  return {
    provisioning,
    account: account ?? null,
    signIn: settings?.signIn ?? null,
    signInOverridden: settings?.signInOverridden ?? false,
    teamsBot: settings?.teamsBot ?? null,
    configPending: settings?.configPending ?? false,
    sealedSecrets,
    watched,
    workers,
    resources: await resourcesOf(db, runs),
    releases: listed.releases
      .slice(0, setupReleaseLimit)
      .map(({ id, notes, builtAt, versionMajor, versionMinor }) => ({
        id,
        notes,
        builtAt,
        versionMajor,
        versionMinor,
      })),
    newestReleaseId: listed.releases[0]?.id ?? null,
    moreReleases:
      listed.releases.length > setupReleaseLimit || listed.older !== null,
    behind: await behindOf(db, runs),
    rollout,
    done: history.filter(
      ({ actor, action }) => actor !== "system" && byHand.has(action)
    ),
    history,
  };
};
