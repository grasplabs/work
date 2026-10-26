/** Reading rollouts, as the rollout pages show them. */
import { desc, eq, sql } from "drizzle-orm";

import { adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import { clients, releases, rollouts, rolloutTargets } from "../db/schema.ts";
import { listReleases, versionsOf } from "../releases/queries.ts";
import { instanceStatus } from "../runners.ts";
import type { RunStatus } from "../runners.ts";
import { firstRing } from "./targets.ts";

/** How many rollouts the list shows: the latest. */
const listed = 50;

/** A rollout as the list shows it. */
export interface RolloutSummary {
  id: string;
  kind: (typeof rollouts.kind.enumValues)[number];
  releaseId: string | null;
  /** Its release as the lists name it (src/releases/version.ts), for a release rollout. */
  release: {
    notes: string;
    versionMajor: number | null;
    versionMinor: number | null;
  } | null;
  status: (typeof rollouts.status.enumValues)[number];
  ring: number;
  startedBy: string;
  createdAt: Date;
}

/** A rollout's columns, with its release's note beside it. */
const summaryColumns = {
  id: rollouts.id,
  kind: rollouts.kind,
  releaseId: rollouts.releaseId,
  status: rollouts.status,
  ring: rollouts.ring,
  startedBy: rollouts.startedBy,
  createdAt: rollouts.createdAt,
  notes: sql<string | null>`json_extract(${releases.manifest}, '$.notes')`,
};

/** A row of `summaryColumns`. */
type SummaryRow = Omit<RolloutSummary, "release"> & { notes: string | null };

/** Rows of `summaryColumns` as the pages take them, each release with its version. */
const summariesOf = async (
  db: AdminDatabase,
  rows: readonly SummaryRow[]
): Promise<RolloutSummary[]> => {
  const versions = await versionsOf(
    db,
    rows.flatMap(({ releaseId }) => (releaseId === null ? [] : [releaseId]))
  );
  return rows.map(({ notes, ...rollout }) => {
    const version =
      rollout.releaseId === null ? undefined : versions.get(rollout.releaseId);
    return {
      ...rollout,
      release:
        rollout.releaseId === null
          ? null
          : {
              notes: notes ?? "",
              versionMajor: version?.versionMajor ?? null,
              versionMinor: version?.versionMinor ?? null,
            },
    };
  });
};

/** The latest rollouts, newest first. */
export const listRollouts = async (
  db: AdminDatabase
): Promise<RolloutSummary[]> => {
  const rows = await db
    .select(summaryColumns)
    .from(rollouts)
    .leftJoin(releases, eq(releases.id, rollouts.releaseId))
    .orderBy(desc(rollouts.createdAt))
    .limit(listed);
  return await summariesOf(db, rows);
};

/** One client in a rollout, as its page shows it. */
export interface TargetView {
  clientId: string;
  ring: number;
  status: (typeof rolloutTargets.status.enumValues)[number];
  error: string | null;
  updatedAt: Date;
}

/** A rollout, as its page shows it. */
export interface RolloutView extends RolloutSummary {
  /** Its run's status, as Workflows has it: `paused` while staff paused it. */
  run: RunStatus;
  /** Its clients, ring by ring, then by id. */
  targets: TargetView[];
}

/** Rollout `id`, or null when there's none. */
export const getRollout = async (
  env: Env,
  id: string
): Promise<RolloutView | null> => {
  const db = adminDatabase(env.DB);
  const [row] = await db
    .select(summaryColumns)
    .from(rollouts)
    .leftJoin(releases, eq(releases.id, rollouts.releaseId))
    .where(eq(rollouts.id, id));
  if (row === undefined) {
    return null;
  }
  const [rollout] = await summariesOf(db, [row]);
  if (rollout === undefined) {
    return null;
  }
  const targets = await db
    .select({
      clientId: rolloutTargets.clientId,
      ring: rolloutTargets.ring,
      status: rolloutTargets.status,
      error: rolloutTargets.error,
      updatedAt: rolloutTargets.updatedAt,
    })
    .from(rolloutTargets)
    .where(eq(rolloutTargets.rolloutId, id));
  const { status } = await instanceStatus(env.ROLLOUT, id, rollout.createdAt);
  return {
    ...rollout,
    run: status,
    targets: targets.toSorted(
      (a, b) => a.ring - b.ring || a.clientId.localeCompare(b.clientId)
    ),
  };
};

/** What the form to start a rollout offers. */
export interface RolloutOptions {
  /** The imported releases, newest first. */
  releases: {
    id: string;
    notes: string;
    versionMajor: number | null;
    versionMinor: number | null;
  }[];
  /** The ring every rollout reaches first (`firstRing`). */
  firstRing: number;
  /** Each ring active clients are in, with how many, in order. */
  rings: { ring: number; clients: number }[];
  /** The active clients past ring 0, by id: those a rollout can be started for. */
  clientIds: string[];
}

/** What a rollout can be started with. */
export const rolloutOptions = async (
  db: AdminDatabase
): Promise<RolloutOptions> => {
  const { releases: imported } = await listReleases(db);
  const active = await db
    .select({ id: clients.id, ring: clients.ring })
    .from(clients)
    .where(eq(clients.status, "active"));
  const counts = new Map<number, number>();
  for (const { ring } of active) {
    counts.set(ring, (counts.get(ring) ?? 0) + 1);
  }
  return {
    releases: imported.map(({ id, notes, versionMajor, versionMinor }) => ({
      id,
      notes,
      versionMajor,
      versionMinor,
    })),
    firstRing,
    rings: [...counts]
      .map(([ring, count]) => ({ ring, clients: count }))
      .toSorted((a, b) => a.ring - b.ring),
    clientIds: active
      .filter(({ ring }) => ring !== firstRing)
      .map(({ id }) => id)
      .toSorted((a, b) => a.localeCompare(b)),
  };
};
