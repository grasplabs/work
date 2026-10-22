/**
 * What the admin's Platform page reads beside the client grid
 * (`fetchClientGrid`, `fetchGridLive`): the releases the console
 * imported, the rollout it shows (`goingOut`) with its targets, and what
 * staff did (`staffEvents`). All
 * of it is what the console recorded, read with the rollout and release
 * pages' own queries.
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { and, desc, eq, inArray, ne } from "drizzle-orm";

import { consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { auditEvents, rollouts as rolloutRows } from "../db/schema.ts";
import { listReleases } from "../releases/queries.ts";
import type { ReleaseSummary } from "../releases/queries.ts";
import { getRollout, listRollouts } from "../rollout/queries.ts";
import type { RolloutView } from "../rollout/queries.ts";
import { goingOut } from "./platform.ts";

/**
 * What someone at Grasp does to the platform by hand, as the console's
 * audit log names it: starting and steering rollouts, rolling a client
 * back, and moving, pinning or rotating a client. The console's own jobs
 * (actor `system`) and each deploy's steps aren't "done here".
 */
export const staffActions = [
  "rollout.start",
  "rollout.approve",
  "rollout.pause",
  "rollout.resume",
  "rollout.cancel",
  "rollout.rollback",
  "client.create",
  "client.ring",
  "client.pin",
  "client.unpin",
  "client.rotate_secrets",
  "client.apply_settings",
  "client.sign_in",
] as const;
export type StaffAction = (typeof staffActions)[number];

/** How many of what staff did the page lists: the latest. */
export const staffEventLimit = 10;

/** One thing someone at Grasp did, as the audit log keeps it: identifiers only. */
export interface StaffEvent {
  id: string;
  at: Date;
  actor: string;
  action: StaffAction;
  clientId: string | null;
  target: string | null;
  /**
   * For a rollout's action, what it rolls out, as the reader tells rollouts
   * apart: its release's id, or `secrets`. Null for a client's action, or a
   * rollout the console no longer has.
   */
  rollout: string | null;
}

const isStaffAction = (action: string): action is StaffAction =>
  staffActions.some((each) => each === action);

/** The latest of what staff did, newest first. */
export const staffEvents = async (
  db: ConsoleDatabase
): Promise<StaffEvent[]> => {
  const rows = await db
    .select({
      id: auditEvents.id,
      at: auditEvents.at,
      actor: auditEvents.actor,
      action: auditEvents.action,
      clientId: auditEvents.clientId,
      target: auditEvents.target,
      rolloutKind: rolloutRows.kind,
      rolloutRelease: rolloutRows.releaseId,
    })
    .from(auditEvents)
    .leftJoin(rolloutRows, eq(rolloutRows.id, auditEvents.target))
    .where(
      and(
        ne(auditEvents.actor, "system"),
        inArray(auditEvents.action, [...staffActions])
      )
    )
    .orderBy(desc(auditEvents.at), desc(auditEvents.id))
    .limit(staffEventLimit);
  return rows.flatMap(({ action, rolloutKind, rolloutRelease, ...row }) => {
    if (!isStaffAction(action)) {
      return [];
    }
    const rollout =
      rolloutKind === "secrets" ? "secrets" : (rolloutRelease ?? null);
    return [{ ...row, action, rollout }];
  });
};

/** What the Platform page reads of releases, rollouts and staff's actions. */
export interface PlatformData {
  /** The newest first. */
  releases: ReleaseSummary[];
  /** The rollout going out, or else the latest; null before any. */
  rollout: RolloutView | null;
  /** What staff did, the latest first (`staffEvents`). */
  events: StaffEvent[];
}

export const platformData = async (envOf: Env): Promise<PlatformData> => {
  const db = consoleDatabase(envOf.DB);
  const [{ releases }, rollouts, events] = await Promise.all([
    listReleases(db),
    listRollouts(db),
    staffEvents(db),
  ]);
  const shown = goingOut(rollouts);
  return {
    releases,
    rollout: shown === null ? null : await getRollout(envOf, shown.id),
    events,
  };
};

/** The Platform page's releases and rollout. */
export const fetchPlatform = createServerFn({ method: "GET" }).handler(
  async () => await platformData(env)
);
