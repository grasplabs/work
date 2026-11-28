/**
 * Release channels: Edge, Beta and Stable. Each points at one release, and
 * every client follows one (Stable unless staff move it), unless it's
 * pinned to a release of its own. These actions only change that desired
 * state, each audited; the rollout pass deploys it
 * (src/rollout/scheduler.ts).
 *
 * Each move of a channel starts its rollout of the release (`rollouts`)
 * in the batch that moves it, and supersedes the one it had: the move's
 * actor is the rollout's approver (`started_by`), one approval per
 * channel and release.
 * - A new release goes to Edge by itself, in the batch the admin imports
 *   it in, on every stage alike (`toEdge`).
 * - Staff promote a release from Edge to Beta, and from Beta to Stable
 *   (`promoteRelease`), not while its rollout on the channel before is
 *   halted; rolling a channel back is setting it to a release it had
 *   before (src/rollout/desired.ts).
 * - Resume sets a halted rollout going again, its failed organizations
 *   tried again (`resumeRollout`); Retry tries one client's failed deploy
 *   again, pinned or not, from its Setup (`retryClient`).
 * - Pin, unpin and move change one client's fields (`pinClient`,
 *   `setClientChannel`).
 *
 * A channel's history is its `channel.promote` events in the audit log.
 */
import "@tanstack/react-start/server-only";
import { canMove } from "@grasp-os/shared/release-apply";
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
import { actIfChanged, adminDatabase, auditIfChanged } from "../db/act.ts";
import type { Actor, AdminDatabase } from "../db/act.ts";
import {
  auditEvents,
  channels,
  clientDeploys,
  clients,
  releases,
  rollouts,
} from "../db/schema.ts";
import { importedManifest } from "../deploy/release.ts";
import { channelIds } from "./channel-ids.ts";
import type { Channel } from "./channel-ids.ts";
import { previousChannel, promotionRefusal } from "./desired.ts";
import type { Promotion } from "./desired.ts";
import { RolloutError } from "./errors.ts";
import { liveRolloutStatuses } from "./plan.ts";
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
 * Whether release `releaseId`'s rollout on the channel before `channel`
 * is halted, as SQL: what keeps a promotion from going on past it. Only
 * while it is: once that channel moves on, its rollout is superseded, and
 * staff decide.
 */
const previousHalted = (channel: Channel, releaseId: string): SQL => {
  const previous = previousChannel[channel];
  return previous === null
    ? sql`0`
    : sql`EXISTS (SELECT 1 FROM ${rollouts} WHERE ${rollouts.channel} = ${previous} AND ${rollouts.releaseId} = ${releaseId} AND ${rollouts.status} = 'halted')`;
};

/**
 * `channel`'s new rollout of `releaseId` by `actor`, as statements to run
 * before the move they belong to, each only `when` it holds as read then:
 * the channel's live rollout superseded, and the new one started.
 */
const startRollout = (
  db: AdminDatabase,
  actor: Actor,
  { channel, releaseId, rolloutId }: Promotion & { rolloutId: string },
  when: SQL,
  now: Date
): [BatchItem<"sqlite">, BatchItem<"sqlite">] => [
  db
    .update(rollouts)
    .set({ status: "superseded", endedAt: now })
    .where(
      and(
        eq(rollouts.channel, channel),
        inArray(rollouts.status, liveRolloutStatuses),
        when
      )
    ),
  db
    .insert(rollouts)
    .select(
      sql`SELECT ${rolloutId}, ${channel}, ${releaseId}, 'running', ${typeof actor === "string" ? actor : actor.email}, ${now.getTime()}, NULL, NULL, NULL, 0, 0 WHERE ${when}`
    ),
];

/**
 * Points `channel` at `releaseId`, as `actor`, audited with what it
 * pointed at before, and starts its rollout of it, in one batch: only
 * from `from`, as read, so two changes at once land one, and, unless it
 * goes `back`, not while the release's rollout on the channel before is
 * halted. Returns whether it changed.
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
  const rolloutId = crypto.randomUUID();
  const pointing =
    from === null
      ? sql`NOT EXISTS (SELECT 1 FROM ${channels} WHERE ${channels.id} = ${channel})`
      : sql`EXISTS (SELECT 1 FROM ${channels} WHERE ${channels.id} = ${channel} AND ${channels.releaseId} = ${from})`;
  const when = sql`${pointing} AND ${bundleKept(releaseId)} AND NOT ${back ? sql`0` : previousHalted(channel, releaseId)}`;
  const move =
    from === null
      ? db
          .insert(channels)
          .select(
            sql`SELECT ${channel}, ${releaseId}, ${now.getTime()}, NULL WHERE ${when}`
          )
          .onConflictDoNothing()
      : db
          .update(channels)
          .set({ releaseId, updatedAt: now, stoppedBy: null })
          .where(and(eq(channels.id, channel), when));
  const results = await db.batch([
    ...startRollout(db, actor, { channel, releaseId, rolloutId }, when, now),
    move,
    auditIfChanged(db, actor, {
      action: promoteAction,
      target: releaseId,
      detail: {
        channel,
        ...(from === null ? {} : { from }),
        back,
        rollout: rolloutId,
      },
    }),
  ]);
  return results[3].length > 0;
};

/**
 * A promotion of `releaseId` to `channel` refused while the release's
 * rollout on the channel before is halted (`previous_channel_halted`).
 */
const assertPreviousGoing = async (
  db: AdminDatabase,
  channel: Channel,
  releaseId: string
): Promise<void> => {
  const previous = previousChannel[channel];
  const halted =
    previous === null
      ? undefined
      : await db
          .select({ id: rollouts.id })
          .from(rollouts)
          .where(
            and(
              eq(rollouts.channel, previous),
              eq(rollouts.releaseId, releaseId),
              eq(rollouts.status, "halted")
            )
          )
          .get();
  if (halted !== undefined) {
    throw new RolloutError(
      "previous_channel_halted",
      `${releaseId}'s rollout before ${channel} is halted`
    );
  }
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
 * (`promotion_not_allowed`), for one that can't read the chats the
 * channel's release stores (`channel_behind_chat_storage`, `canMove`:
 * its clients' deploys would each refuse it), for a release the admin
 * doesn't have or no longer has the bundle of, for a promotion while the
 * release's rollout on the channel before is halted
 * (`previous_channel_halted`), and when the channel changed as it was set
 * (`channel_changed`). Starts the channel's rollout of the release.
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
  if (current !== null) {
    const [from, to] = await Promise.all([
      importedManifest(db, current),
      importedManifest(db, releaseId),
    ]);
    // No client's scripts are observed here: each client's deploy holds
    // the release to the Durable Object migrations its own scripts ran.
    if (
      from !== null &&
      to !== null &&
      canMove(from, to, { migrated: {} }) !== null
    ) {
      throw new RolloutError(
        "channel_behind_chat_storage",
        `${releaseId} can't read the chats ${current} stores`
      );
    }
  }
  const back = history.some((event) => event.channel === channel);
  if (!back) {
    await assertPreviousGoing(db, channel, releaseId);
  }
  const changed = await pointChannel(db, staff, {
    channel,
    releaseId,
    from: current,
    back,
  });
  if (!changed) {
    // Its bundle claimed since it was checked, its rollout before halted,
    // or the channel moved.
    await assertDeployable(db, releaseId);
    if (!back) {
      await assertPreviousGoing(db, channel, releaseId);
    }
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
 * Takes Edge to release `releaseId`, as the admin itself, audited, and
 * starts Edge's rollout of it (by `system`): only when it's newer than
 * Edge's release, or Edge has none. As statements, for the batch that
 * saves the release (src/releases/import.ts), so a saved release never
 * misses Edge. A release imported late stays where it is, and so does an
 * Edge staff set back, until a newer release comes.
 */
export const toEdge = (
  db: AdminDatabase,
  releaseId: string
): [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] => {
  const now = new Date();
  const rolloutId = crypto.randomUUID();
  const edge = sql`${channels.id} = 'edge'`;
  const older = sql`NOT EXISTS (SELECT 1 FROM ${channels} WHERE ${edge} AND ${releaseOrderSql(channels.releaseId)} >= ${releaseOrderSql(releaseId)})`;
  // The event and the rollout first, while Edge still has the release it had.
  const event = db
    .insert(auditEvents)
    .select(
      sql`SELECT ${crypto.randomUUID()}, ${now.getTime()}, 'system', ${promoteAction}, NULL, ${releaseId}, json_object('channel', 'edge', 'from', (SELECT ${channels.releaseId} FROM ${channels} WHERE ${edge}), 'back', json('false'), 'rollout', ${rolloutId}) WHERE ${older}`
    );
  const move = db
    .insert(channels)
    .values({ id: "edge", releaseId, updatedAt: now })
    .onConflictDoUpdate({
      target: channels.id,
      set: { releaseId, updatedAt: now, stoppedBy: null },
      setWhere: sql`${releaseOrderSql(channels.releaseId)} < ${releaseOrderSql(releaseId)}`,
    });
  return [
    event,
    ...startRollout(
      db,
      "system",
      { channel: "edge", releaseId, rolloutId },
      older,
      now
    ),
    move,
  ];
};

/** Resuming a channel's halted rollout. */
export const resumeSchema = z.object({ channel: z.enum(channelIds) });

/**
 * Sets `input.channel`'s halted rollout going again, as `staff`, audited
 * (`rollout.resume`, with how many failed organizations it cleared), in
 * one batch: its failed deploys cleared, so the pass deploys those
 * clients again in their turn, and its failures counted from 0 again.
 * Refused while the channel's rollout isn't halted (`not_halted`).
 */
export const resumeRollout = async (
  env: Env,
  staff: Staff,
  input: z.infer<typeof resumeSchema>
): Promise<void> => {
  const db = adminDatabase(env.DB);
  const { channel } = resumeSchema.parse(input);
  const halted = await db
    .select({ id: rollouts.id, releaseId: rollouts.releaseId })
    .from(rollouts)
    .where(and(eq(rollouts.channel, channel), eq(rollouts.status, "halted")))
    .get();
  if (halted === undefined) {
    throw new RolloutError("not_halted", `${channel}'s rollout isn't halted`);
  }
  const now = new Date();
  const still = sql`EXISTS (SELECT 1 FROM ${rollouts} WHERE ${rollouts.id} = ${halted.id} AND ${rollouts.status} = 'halted')`;
  const [, recorded] = await db.batch([
    db
      .delete(clientDeploys)
      .where(
        and(
          eq(clientDeploys.rolloutId, halted.id),
          eq(clientDeploys.status, "failed"),
          still
        )
      ),
    // Right after the delete, so it counts what that cleared.
    db
      .insert(auditEvents)
      .select(
        sql`SELECT ${crypto.randomUUID()}, ${now.getTime()}, ${staff.email}, 'rollout.resume', NULL, ${halted.id}, json_object('channel', ${channel}, 'release', ${halted.releaseId}, 'cleared', changes()) WHERE ${still}`
      )
      .returning({ id: auditEvents.id }),
    db
      .update(channels)
      .set({ stoppedBy: null })
      .where(and(eq(channels.id, channel), still)),
    db
      .update(rollouts)
      .set({ status: "running", resumedAt: now, failed: 0 })
      .where(and(eq(rollouts.id, halted.id), eq(rollouts.status, "halted"))),
  ]);
  if (recorded.length === 0) {
    throw new RolloutError("not_halted", `${channel}'s rollout isn't halted`);
  }
};

/** Retrying one client's failed deploy. */
export const retryClientSchema = z.object({ clientId: z.string().min(1) });

/**
 * Clears client `input.clientId`'s failed deploy, as `staff`, audited
 * (`client.retry`): the rollout pass then deploys it again in its turn,
 * pinned or not. Nothing when its last deploy didn't fail. Only a halt
 * stops a channel's rollout, and resuming it clears its own failures:
 * this is how any other failure is tried again.
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
 * the rollout pass then takes it to the channel's release, unless it's
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
 * or unpins it (`null`), audited: the rollout pass then takes it to the
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
