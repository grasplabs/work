/**
 * Where a client's self-healing provisioning stands, read from the audit
 * log alone (src/hosting/reconcile.ts writes it): its episode, the
 * automatic resumes in it, and whether the admin gave up and a person
 * needs to look (`provision.needs_attention`). No table of its own, so
 * nothing to drift: a staff member starting, resuming or switching the
 * client starts a new episode, which clears it.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { AdminDatabase } from "../db/act.ts";
import { auditEvents } from "../db/schema.ts";

/** What a resume by the reconciler is audited as. */
export const autoResumeAction = "provision.auto_resume";

/** What the reconciler giving up, once an episode, is audited as. */
export const needsAttentionAction = "provision.needs_attention";

/**
 * Why a person needs to look: its automatic resumes haven't got it
 * through (`stuck`), or it stopped for something the admin can't fix by
 * itself (`needs_person`).
 */
export const attentionReasons = ["stuck", "needs_person"] as const;
export type AttentionReason = (typeof attentionReasons)[number];

/** A client needing a person, as Setup and the Platform grid show it. */
export interface NeedsAttention {
  reason: AttentionReason;
  /** The automatic resumes it had when the admin gave up. */
  attempts: number;
  /** The code it stopped with, when it said one. */
  code: string | null;
  at: Date;
}

/**
 * What a staff member does that starts an episode afresh: adding the
 * client, placing it, starting or resuming it, or switching its release.
 */
const byHandActions = [
  "client.create",
  "client.place",
  "client.provision_placed",
  "provision.switch_release",
];

/** Where a client's episode stands, as its audit events tell it. */
export interface Episode {
  /** When staff last acted on its provisioning; the epoch when they never did. */
  startedAt: Date;
  /** The automatic resumes since. */
  attempts: number;
  lastAttemptAt: Date | null;
}

/** When client `clientId`'s current episode started. */
const episodeStart = async (
  db: AdminDatabase,
  clientId: string
): Promise<Date> => {
  const [byHand] = await db
    .select({ at: auditEvents.at })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.clientId, clientId),
        inArray(auditEvents.action, byHandActions),
        sql`${auditEvents.actor} <> 'system'`
      )
    )
    .orderBy(desc(auditEvents.at))
    .limit(1);
  return byHand?.at ?? new Date(0);
};

/** Client `clientId`'s episode, from its audit events. */
export const episodeOf = async (
  db: AdminDatabase,
  clientId: string
): Promise<Episode> => {
  const startedAt = await episodeStart(db, clientId);
  const resumes = await db
    .select({ at: auditEvents.at })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.clientId, clientId),
        eq(auditEvents.action, autoResumeAction),
        sql`${auditEvents.at} > ${startedAt.getTime()}`
      )
    )
    .orderBy(desc(auditEvents.at));
  return {
    startedAt,
    attempts: resumes.length,
    lastAttemptAt: resumes[0]?.at ?? null,
  };
};

const detailSchema = z.object({
  attempts: z.number().int().nonnegative(),
  code: z.string().optional(),
});

/**
 * Whether client `clientId` needs a person in its current episode: the
 * latest `provision.needs_attention` since staff last acted on it; null
 * when there is none.
 */
export const needsAttentionOf = async (
  db: AdminDatabase,
  clientId: string
): Promise<NeedsAttention | null> => {
  const startedAt = await episodeStart(db, clientId);
  const [event] = await db
    .select({
      at: auditEvents.at,
      target: auditEvents.target,
      detail: auditEvents.detail,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.clientId, clientId),
        eq(auditEvents.action, needsAttentionAction),
        sql`${auditEvents.at} > ${startedAt.getTime()}`
      )
    )
    .orderBy(desc(auditEvents.at))
    .limit(1);
  if (event === undefined) {
    return null;
  }
  const reason = z.enum(attentionReasons).safeParse(event.target);
  const detail = detailSchema.safeParse(JSON.parse(event.detail ?? "{}"));
  return {
    reason: reason.success ? reason.data : "needs_person",
    attempts: detail.success ? detail.data.attempts : 0,
    code: detail.success ? (detail.data.code ?? null) : null,
    at: event.at,
  };
};

/**
 * Records that client `clientId` needs a person for `reason`, once in
 * `episode`: written only while `episode` is still the current one (no
 * staff action on it since it started) and no such event is since it
 * started, in one statement, so two runs at once record it once and none
 * lands in an episode staff have since started afresh. Whether this call
 * recorded it.
 */
export const markNeedsAttention = async (
  db: AdminDatabase,
  clientId: string,
  episode: Episode,
  { reason, code }: { reason: AttentionReason; code: string | null }
): Promise<boolean> => {
  const id = crypto.randomUUID();
  const detail = JSON.stringify({
    attempts: episode.attempts,
    ...(code === null ? {} : { code }),
  });
  const recorded = await db
    .insert(auditEvents)
    .select(
      sql`SELECT ${id}, ${Date.now()}, 'system', ${needsAttentionAction}, ${clientId}, ${reason}, ${detail} WHERE NOT EXISTS (SELECT 1 FROM ${auditEvents} WHERE ${auditEvents.clientId} = ${clientId} AND ${auditEvents.action} = ${needsAttentionAction} AND ${auditEvents.at} > ${episode.startedAt.getTime()}) AND NOT EXISTS (SELECT 1 FROM ${auditEvents} WHERE ${auditEvents.clientId} = ${clientId} AND ${inArray(auditEvents.action, byHandActions)} AND ${auditEvents.actor} <> 'system' AND ${auditEvents.at} > ${episode.startedAt.getTime()})`
    )
    .returning({ id: auditEvents.id });
  return recorded.length > 0;
};
