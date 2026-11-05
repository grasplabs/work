import type { ProviderTrouble } from "@grasp-os/shared/ai-providers";
import { createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { waitUntil } from "cloudflare:workers";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { auditedBatch, keepAuditEvent } from "./audit-outbox.ts";
import { auditOutbox, modelUsage, providerHealth } from "./db/core/schema.ts";
import { retriedBatch } from "./db/d1.ts";
import { spendKeysOf, spendMonth } from "./model-spend.ts";
import type { SpendInput } from "./model-spend.ts";

// What the model gateway (models.ts) records after each response, the way
// the usual gateways meter spend: once the provider answered, from the
// usage it reported, never as a reservation before the request. One D1
// batch holds the response's `model.call` audit event, its usage row
// (model-spend.ts reads them) and its provider's health, so the three are
// kept or lost together. The batch runs in the background (`waitUntil`):
// the answer never waits on it, and nothing in it can fail or refuse a
// call. A batch D1 failed for a moment is tried again (`retriedBatch`; it
// inserts by ID, so a try that committed is not counted twice); one that
// still fails is logged as `model.usage_unrecorded`, and its audit event
// kept on its own (`keepAuditEvent`), which falls back to the log itself.

/** What one response used, as its usage row keeps it. */
export interface UsageRecord {
  /** The provider request's ID: one row per response. */
  id: string;
  /** `<provider>/<model>`. */
  model: string;
  credential: "organization" | "platform";
  /** Which of Grasp's own features, on Grasp's key. */
  feature?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** US dollars at list prices. */
  cost: number;
  /** Whether any of it is an estimate, not the provider's count. */
  estimated: boolean;
  /** The usage as the provider reported it, through pi. */
  reported?: Json;
}

/**
 * How a provider's request fared, for its health: it worked, or it failed
 * as `failure` (a `TransportFailure`'s kind), with what that shows of the
 * provider (`trouble`), if anything.
 */
export interface ProviderNote {
  provider: string;
  credential: string;
  failed?: { failure: string; status?: number; trouble?: ProviderTrouble };
}

/** What the gateway records after one response. */
export interface ResponseRecord {
  /** Its `model.call` audit event. */
  entry: AuditEntry;
  /** Whom and what its spend counts for. */
  spend: SpendInput;
  /** What it used; none when no request was answered. */
  usage?: UsageRecord;
  /** How its provider fared; none for a call its caller cancelled. */
  health?: ProviderNote;
}

/** How each provider's requests fared last, by whose key. */
export type ProviderHealth = typeof providerHealth.$inferSelect;

/**
 * The upsert that notes `note` in its provider's health: when it last
 * worked or failed, and for a failure that shows something of the
 * provider, its class since the first failure of that class after the last
 * that worked. A failure that shows nothing (a refusal of the request
 * itself) leaves the class as it was.
 */
const healthNoted = (
  db: DrizzleD1Database,
  { provider, credential, failed }: ProviderNote,
  now: number
) => {
  const target = [providerHealth.provider, providerHealth.credential];
  if (failed === undefined) {
    return db
      .insert(providerHealth)
      .values({ provider, credential, lastOkAt: now })
      .onConflictDoUpdate({
        target,
        set: { lastOkAt: now, failingClass: null, failingSince: null },
      });
  }
  const noted = {
    lastFailedAt: now,
    lastFailure: failed.failure,
    lastStatus: failed.status ?? null,
  };
  const { trouble } = failed;
  return db
    .insert(providerHealth)
    .values({
      provider,
      credential,
      ...noted,
      failingClass: trouble ?? null,
      failingSince: trouble === undefined ? null : now,
    })
    .onConflictDoUpdate({
      target,
      set:
        trouble === undefined
          ? noted
          : {
              ...noted,
              failingClass: trouble,
              failingSince: sql`CASE WHEN ${providerHealth.failingClass} = ${trouble} THEN coalesce(${providerHealth.failingSince}, ${now}) ELSE ${now} END`,
            },
    });
};

/** The batch that records `record`, its audit event once by its ID. */
const recordOnce = async (
  env: Env,
  db: DrizzleD1Database & { $client: D1Database },
  { spend, usage, health }: ResponseRecord,
  event: ReturnType<typeof createAuditEvent>
): Promise<void> => {
  const now = Date.now();
  await auditedBatch(env, db, [
    db
      .insert(auditOutbox)
      .values({
        id: event.id,
        event: JSON.stringify(event),
        createdAt: new Date(now),
      })
      .onConflictDoNothing(),
    ...(usage === undefined
      ? []
      : [
          db
            .insert(modelUsage)
            .values({
              ...usage,
              ...spendKeysOf(spend),
              feature: usage.feature ?? null,
              reported: usage.reported ?? null,
              period: spendMonth(env),
              createdAt: new Date(now),
            })
            .onConflictDoNothing(),
        ]),
    ...(health === undefined ? [] : [healthNoted(db, health, now)]),
  ]);
};

/**
 * Records one response (`ResponseRecord`). Never throws: a failure is
 * logged, and the audit event kept on its own.
 */
export const recordResponse = async (
  env: Env,
  record: ResponseRecord
): Promise<void> => {
  const db = drizzle(env.DB);
  try {
    const event = createAuditEvent(record.entry, "core");
    await retriedBatch(async () => {
      await recordOnce(env, db, record, event);
    });
  } catch (error) {
    log.error("model.usage_unrecorded", {
      ...errorFields(error),
      model: record.usage?.model,
    });
    await keepAuditEvent(env, db, record.entry);
  }
};

/** {@link recordResponse} in the background: the answer never waits on it. */
export const recordAfterResponse = (env: Env, record: ResponseRecord): void => {
  waitUntil(recordResponse(env, record));
};

/** How each provider's requests fared last, by whose key. */
export const providerHealthOf = async (
  env: Pick<Env, "DB">
): Promise<ProviderHealth[]> =>
  await drizzle(env.DB)
    .select()
    .from(providerHealth)
    .orderBy(asc(providerHealth.provider), asc(providerHealth.credential));

/**
 * Notes that the organization replaced `provider`'s key: its run of
 * failures, which the old key's refusals made, is over until a request
 * with the new key fails. When the last one failed stays.
 */
export const keyReplaced = async (
  env: Pick<Env, "DB">,
  provider: string
): Promise<void> => {
  await drizzle(env.DB)
    .update(providerHealth)
    .set({ failingClass: null, failingSince: null })
    .where(
      and(
        eq(providerHealth.provider, provider),
        eq(providerHealth.credential, "organization")
      )
    );
};
