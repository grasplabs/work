/**
 * What the admin's Platform page reads beside the client grid
 * (`fetchClientGrid`, `fetchGridLive`): each channel's progress and its
 * promotion history (src/rollout/progress.ts), and what staff did
 * (`staffEvents`). All of it is what the admin recorded.
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { and, desc, inArray, ne } from "drizzle-orm";

import { clientGrid } from "../clients/grid.ts";
import { adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import { auditEvents } from "../db/schema.ts";
import type { PromotionEvent } from "../rollout/channels.ts";
import { channelsProgress } from "../rollout/progress.ts";
import type { ChannelProgress } from "../rollout/progress.ts";
import { platformCounts } from "./platform.ts";
import type { PlatformCounts } from "./platform.ts";

/**
 * What someone at Grasp does to the platform by hand, as the admin's
 * audit log names it: promoting a release, retrying a channel, rolling
 * out secrets, and adding, moving, pinning or rotating a client. The
 * admin's own jobs (actor `system`) and each deploy's steps aren't "done
 * here".
 */
export const staffActions = [
  "channel.promote",
  "channel.retry",
  "secrets.roll_out",
  "client.create",
  "client.discard",
  "client.channel",
  "client.pin",
  "client.unpin",
  "client.rotate_secrets",
  "client.apply_settings",
  "client.sign_in",
  "client.sealed_secret",
  "client.teams_bot",
  "platform.grasp_client",
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
}

const isStaffAction = (action: string): action is StaffAction =>
  staffActions.some((each) => each === action);

/** The latest of what staff did, newest first. */
export const staffEvents = async (db: AdminDatabase): Promise<StaffEvent[]> => {
  const rows = await db
    .select({
      id: auditEvents.id,
      at: auditEvents.at,
      actor: auditEvents.actor,
      action: auditEvents.action,
      clientId: auditEvents.clientId,
      target: auditEvents.target,
    })
    .from(auditEvents)
    .where(
      and(
        ne(auditEvents.actor, "system"),
        inArray(auditEvents.action, [...staffActions])
      )
    )
    .orderBy(desc(auditEvents.at), desc(auditEvents.id))
    .limit(staffEventLimit);
  return rows.flatMap(({ action, ...row }) =>
    isStaffAction(action) ? [{ ...row, action }] : []
  );
};

/** What the Platform page reads of the channels and staff's actions. */
export interface PlatformData {
  /** Edge, Beta, Stable. */
  channels: ChannelProgress[];
  /** Every change of a channel's release, newest first. */
  history: PromotionEvent[];
  /** What staff did, the latest first (`staffEvents`). */
  events: StaffEvent[];
}

export const platformData = async (envOf: Env): Promise<PlatformData> => {
  const db = adminDatabase(envOf.DB);
  const [{ channels, history }, events] = await Promise.all([
    channelsProgress(db),
    staffEvents(db),
  ]);
  return { channels, history, events };
};

/** The Platform page's channels, history and staff's actions. */
export const fetchPlatform = createServerFn({ method: "GET" }).handler(
  async () => await platformData(env)
);

/** What the admin's sidebar says beside Platform (`platformCounts`). */
export const platformSidebar = async (envOf: Env): Promise<PlatformCounts> =>
  platformCounts(await clientGrid(envOf));

/** What the admin's sidebar says beside Platform. */
export const fetchPlatformSidebar = createServerFn({ method: "GET" }).handler(
  async () => await platformSidebar(env)
);
