/**
 * Each channel as the Platform pages show it, derived live from the desired
 * state and each client's last deploy (src/rollout/desired.ts): its
 * release, how many of its clients run it, each client's state, and the
 * moves it may make. Nothing here is stored.
 */
import { eq } from "drizzle-orm";

import type { AdminDatabase } from "../db/act.ts";
import { channelIds, clients } from "../db/schema.ts";
import type { Channel } from "../db/schema.ts";
import { listReleases } from "../releases/queries.ts";
import { promotionHistory } from "./channels.ts";
import type { PromotionEvent } from "./channels.ts";
import { failsChannel, promotableReleases, stateOf } from "./desired.ts";
import type { ClientState } from "./desired.ts";
import { eachPage } from "./reconciler.ts";
import { rolledOutPrints } from "./shared-secrets.ts";
import { channelReleases } from "./targets.ts";

/** One client of a channel, as its progress shows it. */
export interface ClientProgress {
  id: string;
  name: string;
  /** Where it stands; `pinned` for a client on a release of its own. */
  state: ClientState | "pinned";
  /** The release its Workers run; null when they don't run one. */
  running: string | null;
  /** The release it's pinned to; null when it follows the channel. */
  pinnedReleaseId: string | null;
  /** Why its last deploy failed, as a code; null unless it did. */
  error: string | null;
}

/** A channel, as its progress shows it. */
export interface ChannelProgress {
  channel: Channel;
  /** Its release; null before one was promoted to it. */
  releaseId: string | null;
  /** That release's note, as CI wrote it: what it holds. Empty without one. */
  notes: string;
  /** Its active clients, pinned ones included. */
  total: number;
  /** Of those, the ones that run the channel's release, pinned ones not counted. */
  upToDate: number;
  /** Of those, the ones that follow it (not pinned). */
  following: number;
  /** Whether a deploy of its release failed: nothing new starts until Retry. */
  failed: boolean;
  clients: ClientProgress[];
  /** The releases it may be set to, newest first. */
  promotable: string[];
}

/** One channel's progress, its clients read a page at a time. */
const progressOf = async (
  db: AdminDatabase,
  channel: Channel,
  {
    releases,
    rolledOut,
    names,
    history,
    imported,
    notes,
  }: {
    releases: Awaited<ReturnType<typeof channelReleases>>;
    rolledOut: Record<string, string> | null;
    names: ReadonlyMap<string, string>;
    history: readonly PromotionEvent[];
    imported: readonly string[];
    notes: ReadonlyMap<string, string>;
  }
): Promise<ChannelProgress> => {
  const rows: ClientProgress[] = [];
  let failed = false;
  await eachPage(db, channel, rolledOut, (page) => {
    for (const row of page) {
      failed ||= failsChannel(row, releases);
      const state = stateOf(row, releases);
      rows.push({
        id: row.id,
        name: names.get(row.id) ?? row.id,
        state:
          row.pinnedReleaseId !== null && state === "up_to_date"
            ? "pinned"
            : state,
        running: row.running,
        pinnedReleaseId: row.pinnedReleaseId,
        error: state === "failed" ? (row.deploy?.error ?? null) : null,
      });
    }
    return "next";
  });
  const following = rows.filter(
    ({ pinnedReleaseId }) => pinnedReleaseId === null
  );
  return {
    channel,
    releaseId: releases[channel],
    notes: notes.get(releases[channel] ?? "") ?? "",
    total: rows.length,
    following: following.length,
    upToDate: following.filter(({ state }) => state === "up_to_date").length,
    failed,
    clients: rows,
    promotable: promotableReleases(
      channel,
      releases[channel],
      history,
      imported
    ),
  };
};

/** Every channel's progress, Edge first, and its promotion history. */
export const channelsProgress = async (
  db: AdminDatabase
): Promise<{ channels: ChannelProgress[]; history: PromotionEvent[] }> => {
  const releases = await channelReleases(db);
  const rolledOut = await rolledOutPrints(db);
  const history = await promotionHistory(db);
  const { releases: listed } = await listReleases(db);
  const named = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(eq(clients.status, "active"));
  const context = {
    releases,
    rolledOut,
    names: new Map(named.map(({ id, name }) => [id, name])),
    history,
    notes: new Map(listed.map(({ id, notes }) => [id, notes])),
    // A release whose bundle is gone can't be deployed, so isn't offered.
    imported: listed
      .filter(({ bundleDeletedAt }) => bundleDeletedAt === null)
      .map(({ id }) => id),
  };
  const channels = await Promise.all(
    channelIds.map(async (channel) => await progressOf(db, channel, context))
  );
  return { channels, history };
};
