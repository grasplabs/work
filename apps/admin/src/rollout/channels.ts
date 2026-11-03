/**
 * Release channels: Edge, Beta and Stable. Each points at one release, and
 * every client follows one (Stable unless staff move it), unless it's
 * pinned to a release of its own. These actions only change that desired
 * state, each audited; the reconciler deploys it (src/rollout/reconciler.ts).
 *
 * - A new release goes to Edge by itself, in the batch the admin imports
 *   it in, on every stage alike (`toEdge`).
 * - Staff promote a release from Edge to Beta, and from Beta to Stable
 *   (`promoteRelease`); rolling a channel back is setting it to a release
 *   it had before (src/rollout/desired.ts).
 * - Retry clears a channel's failed deploys, so the reconciler tries them
 *   again (`retryChannel`), or one client's, pinned or not, from its
 *   Setup (`retryClient`).
 * - Pin, unpin and move change one client's fields (`pinClient`,
 *   `setClientChannel`).
 *
 * A channel's history is its `channel.promote` events in the audit log.
 */
import { releaseIdSchema } from "@grasp-os/shared/release-id";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { actIfChanged, adminDatabase } from "../db/act.ts";
import type { Actor, AdminDatabase } from "../db/act.ts";
import {
  auditEvents,
  channelIds,
  channels,
  clientDeploys,
  clients,
  releases,
} from "../db/schema.ts";
import { promotionRefusal } from "./desired.ts";
import type { Promotion } from "./desired.ts";
import { RolloutError } from "./errors.ts";
import { channelReleases } from "./targets.ts";

/** The audit action every change of a channel's release is recorded as. */
const promoteAction = "channel.promote";

const promotionDetailSchema = z.object({ channel: z.enum(channelIds) });

/** A change of a channel's release, as the audit log has it. */
export interface PromotionEvent extends Promotion {
  /** The release it pointed at before; null for its first. */
  from: string | null;
  /** Whether it went back to a release the channel had before. */
  back: boolean;
  /** Who: a staff member's email, or `system` for Edge's new releases. */
  actor: string;
  at: Date;
}

const eventDetailSchema = promotionDetailSchema.extend({
  from: z.string().nullable().default(null),
  back: z.boolean().default(false),
});

/**
 * Whether an event names one of `releaseIds`, as SQL: the ids bound as one
 * JSON parameter, so any number of them fit D1's 100 parameters.
 */
const targetIn = (releaseIds: readonly string[]): SQL =>
  sql`${auditEvents.target} IN (SELECT value FROM json_each(${JSON.stringify(releaseIds)}))`;

/**
 * The changes of a channel's release, newest first, as the audit log
 * recorded it: only those naming `releaseIds` when given, and at most
 * `limit` when given.
 */
export const promotionHistory = async (
  db: AdminDatabase,
  { releaseIds, limit }: { releaseIds?: readonly string[]; limit?: number } = {}
): Promise<PromotionEvent[]> => {
  const query = db
    .select({
      target: auditEvents.target,
      detail: auditEvents.detail,
      actor: auditEvents.actor,
      at: auditEvents.at,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, promoteAction),
        releaseIds === undefined ? undefined : targetIn(releaseIds)
      )
    )
    // Changes in one millisecond in the order they were written.
    .orderBy(desc(auditEvents.at), desc(sql`rowid`));
  const rows = await (limit === undefined ? query : query.limit(limit));
  return rows.flatMap(({ target, detail, actor, at }) => {
    const parsed = eventDetailSchema.safeParse(JSON.parse(detail ?? "null"));
    return target === null || !parsed.success
      ? []
      : [{ releaseId: target, ...parsed.data, actor, at }];
  });
};

/**
 * Each channel each of `releaseIds` has been on, once per pair: what its
 * badges and the promotion choices need (`promotionRefusal`), without
 * reading every change ever recorded.
 */
export const channelsOfReleases = async (
  db: AdminDatabase,
  releaseIds: readonly string[]
): Promise<Promotion[]> => {
  const rows = await db
    .selectDistinct({
      releaseId: auditEvents.target,
      channel: sql<unknown>`json_extract(${auditEvents.detail}, '$.channel')`,
    })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, promoteAction), targetIn(releaseIds)));
  return rows.flatMap(({ releaseId, channel }) => {
    const parsed = promotionDetailSchema.shape.channel.safeParse(channel);
    return releaseId === null || !parsed.success
      ? []
      : [{ releaseId, channel: parsed.data }];
  });
};

/**
 * Release `releaseId` refused unless the admin imported it and still has
 * its bundle to deploy (src/releases/retention.ts).
 */
const assertDeployable = async (
  db: AdminDatabase,
  releaseId: string
): Promise<void> => {
  const release = await db
    .select({ bundleDeletedAt: releases.bundleDeletedAt })
    .from(releases)
    .where(eq(releases.id, releaseId))
    .get();
  if (release === undefined) {
    throw new RolloutError(
      "release_not_imported",
      `Release ${releaseId} isn't imported`
    );
  }
  if (release.bundleDeletedAt !== null) {
    throw new RolloutError(
      "bundle_deleted",
      `Release ${releaseId}'s bundle was deleted`
    );
  }
};

/**
 * Whether release `releaseId` still has its bundle, as SQL: checked in the
 * write that points a channel or pins a client at it, so retention's claim
 * (src/releases/retention.ts) and that write never both land.
 */
const bundleKept = (releaseId: string) =>
  sql`EXISTS (SELECT 1 FROM ${releases} WHERE ${releases.id} = ${releaseId} AND ${releases.bundleDeletedAt} IS NULL)`;

/**
 * Points `channel` at `releaseId`, as `actor`, audited with what it
 * pointed at before: only from `from`, as read, so two changes at once
 * land one. Returns whether it changed.
 */
const pointChannel = async (
  db: AdminDatabase,
  actor: Actor,
  {
    channel,
    releaseId,
    from,
    back,
  }: Promotion & { from: string | null; back: boolean }
): Promise<boolean> => {
  const now = new Date();
  const event = {
    action: promoteAction,
    target: releaseId,
    detail: { channel, ...(from === null ? {} : { from }), back },
  };
  if (from === null) {
    return await actIfChanged(
      db,
      actor,
      db
        .insert(channels)
        .select(
          sql`SELECT ${channel}, ${releaseId}, ${now.getTime()} WHERE ${bundleKept(releaseId)}`
        )
        .onConflictDoNothing(),
      event
    );
  }
  return await actIfChanged(
    db,
    actor,
    db
      .update(channels)
      .set({ releaseId, updatedAt: now })
      .where(
        and(
          eq(channels.id, channel),
          eq(channels.releaseId, from),
          bundleKept(releaseId)
        )
      ),
    event
  );
};

/** Promoting a release to a channel, or setting it back, as staff choose it. */
export const promoteSchema = z.object({
  channel: z.enum(channelIds),
  releaseId: releaseIdSchema,
});
export type PromoteInput = z.infer<typeof promoteSchema>;

/**
 * Sets `input.channel` to release `input.releaseId`, as `staff`: a
 * promotion from the channel before it (Edge to Beta, Beta to Stable), or
 * a rollback to a release the channel had before. Refused for any other
 * move (`promotion_not_allowed`), for the release it has already
 * (`promotion_not_allowed`), for a release the admin doesn't have or no
 * longer has the bundle of, and when the channel changed as it was set
 * (`channel_changed`).
 */
export const promoteRelease = async (
  env: Env,
  staff: Staff,
  input: PromoteInput
): Promise<void> => {
  const db = adminDatabase(env.DB);
  const { channel, releaseId } = promoteSchema.parse(input);
  await assertDeployable(db, releaseId);
  const pointing = await channelReleases(db);
  const current = pointing[channel];
  const history = await promotionHistory(db, { releaseIds: [releaseId] });
  const refusal = promotionRefusal(channel, releaseId, current, history);
  if (refusal !== null) {
    throw new RolloutError(
      "promotion_not_allowed",
      `${releaseId} can't go to ${channel}: ${refusal}`
    );
  }
  const back = history.some((event) => event.channel === channel);
  const changed = await pointChannel(db, staff, {
    channel,
    releaseId,
    from: current,
    back,
  });
  if (!changed) {
    // Its bundle claimed since it was checked, or the channel moved.
    await assertDeployable(db, releaseId);
    throw new RolloutError(
      "channel_changed",
      `${channel} changed as it was promoted`
    );
  }
};

/**
 * Release id `id`'s place in `compareReleaseIds`' order, as SQL text that
 * sorts so: every local build (`dev-`, by its text) before every
 * published `YY.MM.N`, those by year, month and N, N padded to its nine
 * digits (@grasp-os/shared/release-id).
 */
const releaseOrderSql = (id: SQLWrapper | string): SQL =>
  sql`CASE WHEN ${id} LIKE 'dev-%' THEN '0' || ${id} ELSE '1' || substr(${id}, 1, 6) || printf('%09d', CAST(substr(${id}, 7) AS INTEGER)) END`;

/**
 * Takes Edge to release `releaseId`, as the admin itself, audited: only
 * when it's newer than Edge's release, or Edge has none. As statements,
 * for the batch that saves the release (src/releases/import.ts), so a
 * saved release never misses Edge. A release imported late stays where
 * it is, and so does an Edge staff set back, until a newer release comes.
 */
export const toEdge = (
  db: AdminDatabase,
  releaseId: string
): [BatchItem<"sqlite">, BatchItem<"sqlite">] => {
  const now = new Date();
  const edge = sql`${channels.id} = 'edge'`;
  // The event first, while Edge still has the release it had.
  const event = db
    .insert(auditEvents)
    .select(
      sql`SELECT ${crypto.randomUUID()}, ${now.getTime()}, 'system', ${promoteAction}, NULL, ${releaseId}, json_object('channel', 'edge', 'from', (SELECT ${channels.releaseId} FROM ${channels} WHERE ${edge}), 'back', json('false')) WHERE NOT EXISTS (SELECT 1 FROM ${channels} WHERE ${edge} AND ${releaseOrderSql(channels.releaseId)} >= ${releaseOrderSql(releaseId)})`
    );
  const move = db
    .insert(channels)
    .values({ id: "edge", releaseId, updatedAt: now })
    .onConflictDoUpdate({
      target: channels.id,
      set: { releaseId, updatedAt: now },
      setWhere: sql`${releaseOrderSql(channels.releaseId)} < ${releaseOrderSql(releaseId)}`,
    });
  return [event, move];
};

/** Retrying a channel's failed deploys. */
export const retrySchema = z.object({ channel: z.enum(channelIds) });

/**
 * Clears `input.channel`'s failed deploys, as `staff`, audited
 * (`channel.retry`): the reconciler then deploys those clients again, and
 * the channel goes on. Nothing when none failed.
 */
export const retryChannel = async (
  env: Env,
  staff: Staff,
  input: z.infer<typeof retrySchema>
): Promise<void> => {
  const db = adminDatabase(env.DB);
  const { channel } = retrySchema.parse(input);
  await actIfChanged(
    db,
    staff,
    db
      .delete(clientDeploys)
      .where(
        and(
          eq(clientDeploys.status, "failed"),
          inArray(
            clientDeploys.clientId,
            db
              .select({ id: clients.id })
              .from(clients)
              .where(eq(clients.channel, channel))
          )
        )
      ),
    {
      action: "channel.retry",
      detail: { channel },
    }
  );
};

/** Retrying one client's failed deploy. */
export const retryClientSchema = z.object({ clientId: z.string().min(1) });

/**
 * Clears client `input.clientId`'s failed deploy, as `staff`, audited
 * (`client.retry`): the reconciler then deploys it again, pinned or not,
 * as many at a time as its channel allows. Nothing when its last deploy
 * didn't fail. A pinned client's failure never stops its channel
 * (src/rollout/desired.ts), so this is how it's tried again.
 */
export const retryClient = async (
  env: Env,
  staff: Staff,
  input: z.infer<typeof retryClientSchema>
): Promise<void> => {
  const db = adminDatabase(env.DB);
  const { clientId } = retryClientSchema.parse(input);
  await actIfChanged(
    db,
    staff,
    db
      .delete(clientDeploys)
      .where(
        and(
          eq(clientDeploys.clientId, clientId),
          eq(clientDeploys.status, "failed")
        )
      ),
    { action: "client.retry", clientId }
  );
};

/** Client `clientId` refused unless the admin has it. */
const assertClient = async (
  db: AdminDatabase,
  clientId: string
): Promise<void> => {
  const client = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();
  if (client === undefined) {
    throw new RolloutError("unknown_client", `No client ${clientId}`);
  }
};

/** Moving a client to a channel. */
export const channelSchema = z.object({
  clientId: z.string().min(1),
  channel: z.enum(channelIds),
});
export type ChannelInput = z.infer<typeof channelSchema>;

/**
 * Moves client `input.clientId` to `input.channel`, as `staff`, audited:
 * the reconciler then takes it to the channel's release, unless it's
 * pinned. Nothing when it follows that channel already.
 */
export const setClientChannel = async (
  env: Env,
  staff: Staff,
  input: ChannelInput
): Promise<void> => {
  const db = adminDatabase(env.DB);
  const { clientId, channel } = channelSchema.parse(input);
  await assertClient(db, clientId);
  await actIfChanged(
    db,
    staff,
    db
      .update(clients)
      .set({ channel, updatedAt: new Date() })
      .where(and(eq(clients.id, clientId), ne(clients.channel, channel))),
    { action: "client.channel", clientId, detail: { channel } }
  );
};

/** Pinning a client: to a release, or to none (unpinned). */
export const pinSchema = z.object({
  clientId: z.string().min(1),
  releaseId: releaseIdSchema.nullable(),
});
export type PinInput = z.infer<typeof pinSchema>;

/**
 * Pins client `input.clientId` to release `input.releaseId`, as `staff`,
 * or unpins it (`null`), audited: the reconciler then takes it to the
 * pinned release, or once unpinned to its channel's. Nothing when it
 * changes nothing.
 */
export const pinClient = async (
  env: Env,
  staff: Staff,
  input: PinInput
): Promise<void> => {
  const db = adminDatabase(env.DB);
  const { clientId, releaseId } = pinSchema.parse(input);
  await assertClient(db, clientId);
  if (releaseId !== null) {
    await assertDeployable(db, releaseId);
  }
  const pinned = clients.pinnedReleaseId;
  const changed = await actIfChanged(
    db,
    staff,
    db
      .update(clients)
      .set({ pinnedReleaseId: releaseId, updatedAt: new Date() })
      .where(
        and(
          eq(clients.id, clientId),
          releaseId === null
            ? isNotNull(pinned)
            : and(
                or(isNull(pinned), ne(pinned, releaseId)),
                bundleKept(releaseId)
              )
        )
      ),
    releaseId === null
      ? { action: "client.unpin", clientId }
      : { action: "client.pin", clientId, target: releaseId }
  );
  // Unchanged: pinned to it already, or its bundle claimed since it was
  // checked, which is refused.
  if (!changed && releaseId !== null) {
    await assertDeployable(db, releaseId);
  }
};
