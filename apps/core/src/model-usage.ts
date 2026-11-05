import type { ProviderTrouble } from "@grasp-os/shared/ai-providers";
import { createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditEntry, AuditEvent } from "@grasp-os/shared/audit";
import { errorFields, log } from "@grasp-os/shared/log";
import { waitUntil } from "cloudflare:workers";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { auditedBatch, keepEvent, outboxedEvent } from "./audit-outbox.ts";
import { modelUsage, providerHealth } from "./db/core/schema.ts";
import { retriedBatch } from "./db/d1.ts";
import { spendKeysOf, spendMonth } from "./model-spend.ts";
import type { SpendInput } from "./model-spend.ts";

// What the model gateway (models.ts) records after each response, the way
// the usual gateways meter spend: once the provider answered, from the
// usage it reported, never as a reservation before the request.
//
// - The response's `model.call` audit event is stored first, one outbox
//   row, awaited as every audited action in core is (`keepEvent`, which
//   falls back to the log itself): it outlives the isolate.
// - Its usage row (model-spend.ts reads them) and its provider's health
//   follow in one D1 batch, in the background (`waitUntil`): the answer
//   never waits on them, and nothing in them can fail or refuse a call.
//   The batch stores the event again, so usage is kept with its event.
// - Every write is by a stable ID (the event's, the provider request's),
//   so a batch D1 failed for a moment is tried again (`retriedBatch`)
//   without counting anything twice, even a try that committed though its
//   answer was lost. One that still fails is logged as
//   `model.usage_unrecorded`: an overview may miss a row; the provider's
//   invoice is the bill.

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

/** The batch that records `record`'s usage and health, its event again by its ID. */
const recordOnce = async (
  env: Env,
  db: DrizzleD1Database & { $client: D1Database },
  { spend, usage, health }: Omit<ResponseRecord, "entry">,
  event: AuditEvent
): Promise<void> => {
  const now = Date.now();
  await auditedBatch(env, db, [
    // Already stored (`recordResponse`): here so usage and its event are
    // kept together, once by the event's ID.
    outboxedEvent(db, event),
    ...(usage === undefined
      ? []
      : [
          db
            .insert(modelUsage)
            .values({
              ...usage,
              ...spendKeysOf(spend),
              feature: usage.feature ?? null,
              period: spendMonth(env),
              createdAt: new Date(now),
            })
            .onConflictDoNothing(),
        ]),
    ...(health === undefined ? [] : [healthNoted(db, health, now)]),
  ]);
};

/** The usage records under way in the background in this isolate. */
const underWay = new Set<Promise<void>>();

/** `usage` once written, then no longer under way (it never throws). */
const forgotten = async (usage: Promise<void>): Promise<void> => {
  await usage;
  underWay.delete(usage);
};

/** Records `record`'s usage and health once its event is stored. Never throws. */
const recordUsage = async (
  env: Env,
  record: Omit<ResponseRecord, "entry">,
  event: AuditEvent
): Promise<void> => {
  const db = drizzle(env.DB);
  try {
    await retriedBatch(async () => {
      await recordOnce(env, db, record, event);
    });
  } catch (error) {
    log.error("model.usage_unrecorded", {
      ...errorFields(error),
      model: record.usage?.model,
    });
  }
};

/**
 * Records one response (`ResponseRecord`): its audit event first, awaited,
 * as every audited action in core is, so it outlives the isolate; then its
 * usage and its provider's health, in the background unless `awaited`,
 * so the answer never waits on them. Never throws: a failure is logged.
 */
export const recordResponse = async (
  env: Env,
  { entry, ...record }: ResponseRecord,
  { awaited = false }: { awaited?: boolean } = {}
): Promise<void> => {
  let event: AuditEvent;
  try {
    event = createAuditEvent(entry, "core");
  } catch (error) {
    // Never expected: the gateway refuses a call whose event can't fit.
    log.error("audit.lost", errorFields(error));
    return;
  }
  await keepEvent(env, drizzle(env.DB), event);
  const usage = recordUsage(env, record, event);
  if (awaited) {
    await usage;
    return;
  }
  underWay.add(usage);
  waitUntil(forgotten(usage));
};

/**
 * Settles once every usage record this isolate began in the background
 * is written (or failed): for a reader that must see what it just spent,
 * such as a test measuring what a trial cost.
 */
export const usageRecorded = async (): Promise<void> => {
  await Promise.all(underWay);
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
