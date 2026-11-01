/**
 * The model ledger's Durable Object SQLite (model-ledger.ts): every
 * provider request and its charge, each scope's spend, and the audit
 * events waiting for the log.
 * Migrates itself on first wake-up after a release.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/** Whose spend a scope counts. */
const scopes = [
  "deployment",
  "workflow",
  "user",
  "run",
  // An App's model binding, by its App and alias (model-spend.ts).
  "binding",
  // Grasp's own AI features on Grasp's key (models.ts, `platformScopes`):
  // counted, never limited, and apart from every scope of the
  // organization's own.
  "platform",
] as const;

/**
 * One provider request: its unique ID, the receipt that it was admitted,
 * the most it can cost at its pinned prices, and what it was charged
 * once settled. Kept a retention after it settled (`settled_at`), then
 * swept.
 */
export const requests = sqliteTable(
  "requests",
  {
    /** The provider request's ID, which core makes once per HTTP request. */
    id: text().primaryKey(),
    /**
     * The hash of what it was admitted with, so an admission repeated
     * after its answer was lost is told from an ID used twice.
     */
    fingerprint: text().notNull(),
    /** The UTC month it counts in, such as `2026-09`. */
    period: text().notNull(),
    /** Its scopes, as JSON. */
    scopes: text().notNull(),
    /** `<provider>/<model>`. */
    model: text().notNull(),
    /** The content hash of the prices it is charged at. */
    priceVersion: text("price_version").notNull(),
    /** The prices, as JSON, so no later catalog reprices it. */
    prices: text().notNull(),
    /**
     * The most it can cost: what it is charged when its usage can't be
     * known.
     */
    reservedMicros: integer("reserved_micros").notNull(),
    /** What it was charged; null until settled. */
    chargedMicros: integer("charged_micros"),
    /**
     * `dispatched` and `unknown` wait to be charged; `settled` was added to
     * spend; `quarantined` couldn't be read to settle.
     */
    state: text({
      enum: ["dispatched", "unknown", "settled", "quarantined"],
    }).notNull(),
    /**
     * How it settled: by its usage, by what it used until it was cut off,
     * refused, never sent, or in full.
     */
    settledBy: text("settled_by", {
      enum: ["usage", "cut", "refused", "unsent", "reconciled"],
    }),
    /** Who or what asked, as JSON, for the audit events it causes. */
    actor: text().notNull(),
    dispatchedAt: integer("dispatched_at").notNull(),
    /** When the call is cut off at the latest. */
    deadline: integer().notNull().default(0),
    /** When it is charged the most it can cost, unless settled before. */
    reconcileAt: integer("reconcile_at").notNull(),
    /** How often reconciling it failed; quarantined once it reaches three. */
    reconcileFailures: integer("reconcile_failures").notNull().default(0),
    settledAt: integer("settled_at"),
    /**
     * The generation of the quota policy whose run lineage limit it was
     * admitted under; null for a request with no lineage, or one admitted
     * before it was recorded.
     */
    policyGeneration: integer("policy_generation"),
    /**
     * Whose share of the requests in flight it takes: the person it counts
     * for (model-admission.ts). Null for one admitted before shares were
     * kept, which holds none.
     */
    subject: text(),
    /** The App whose share it takes; null for a call of no App's. */
    resource: text(),
    /**
     * When its lease on its shares ends at the latest, in ms since the
     * epoch: its call's deadline, a bounded time after it was admitted at
     * most. It holds its shares only while `dispatched` and before this.
     */
    leaseEndsAt: integer("lease_ends_at"),
    /**
     * The way it went (models.ts): its transport (`connect`), the
     * provider and the provider's region
     * (@grasp-os/shared/ai-providers). Metadata only; null for one admitted
     * before routes were recorded, and for a voice model's.
     */
    transport: text(),
    provider: text(),
    region: text(),
    /** Whose key it went with: `organization` or `platform`; null without one. */
    credential: text(),
    /**
     * Which of Grasp's own AI features it was for, on Grasp's key
     * (@grasp-os/shared/platform-ai): `conversion`, `transcription` or
     * `speech`; null for any other request.
     */
    feature: text(),
  },
  (table) => [
    check("requests_reserved", sql`${table.reservedMicros} >= 0`),
    check(
      "requests_settled",
      sql`(${table.state} = 'settled') = (${table.chargedMicros} IS NOT NULL AND ${table.chargedMicros} >= 0 AND ${table.settledBy} IS NOT NULL AND ${table.settledAt} IS NOT NULL)`
    ),
    // The requests still open, soonest due first.
    index("requests_open").on(table.state, table.reconcileAt),
    // Settled requests, oldest first, for the retention sweep.
    index("requests_settled_at").on(table.settledAt),
    // The leases held: requests in flight, by when they end.
    index("requests_leases").on(table.state, table.leaseEndsAt),
    // Grasp's own features' requests, month by month: what the admin's
    // spend overview sums (`platformSpend`), never a scan of them all.
    index("requests_credential_period").on(table.credential, table.period),
  ]
);

/**
 * The model calls waiting for a share of the requests in flight
 * (model-admission.ts), one place per call: each place lasts while its call
 * asks again, and lapses once it stops.
 */
export const queue = sqliteTable(
  "queue",
  {
    /** The waiting call's ID, which core makes once per call. */
    place: text().primaryKey(),
    subject: text().notNull(),
    /** The call's App; empty for a call of no App's. */
    resource: text().notNull(),
    /** Its turn among its person's places in its App: served by turn first. */
    turn: integer().notNull(),
    enqueuedAt: integer("enqueued_at").notNull(),
    /** When its call last asked: it lapses a while after. */
    seenAt: integer("seen_at").notNull(),
    /** Which share it waits for: `client`, `person` or `app`. */
    waitingFor: text("waiting_for", {
      enum: ["client", "person", "app"],
    }).notNull(),
    /** When it asks again at the latest. */
    retryAt: integer("retry_at").notNull(),
  },
  (table) => [
    // The places still asking, in the order they are served.
    index("queue_order").on(table.turn, table.enqueuedAt, table.place),
    // The places that stopped asking, to drop.
    index("queue_seen").on(table.seenAt),
    // A person's places in an App, and an App's: their caps and turns.
    index("queue_subject").on(table.subject, table.resource, table.seenAt),
    index("queue_resource").on(table.resource, table.seenAt),
  ]
);

/**
 * The highest quota policy generation an admission carried, one row: no
 * admission under a lower one is admitted after it (model-ledger.ts).
 */
export const policy = sqliteTable(
  "policy",
  {
    id: integer().primaryKey(),
    generation: integer().notNull(),
  },
  (table) => [
    check("policy_one_row", sql`${table.id} = 0`),
    check("policy_generation", sql`${table.generation} >= 0`),
  ]
);

/**
 * What a scope spent in a month: the deployment, a workflow, a person; or
 * a run lineage, for its whole life, under the period `lineage`
 * (model-ledger.ts). A request counts against all of its scopes at once,
 * and adds its charge to their spend when it settles.
 */
export const spend = sqliteTable(
  "spend",
  {
    scope: text({ enum: scopes }).notNull(),
    key: text().notNull(),
    period: text().notNull(),
    spentMicros: integer("spent_micros").notNull().default(0),
    /**
     * How many provider requests it admitted, retries too: one never sent
     * gives its count back. A run lineage's are limited.
     */
    requests: integer().notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.key, table.period] }),
    check("spend_spent", sql`${table.spentMicros} >= 0`),
    index("spend_top").on(
      table.scope,
      table.period,
      table.spentMicros,
      table.key
    ),
  ]
);

/**
 * How each provider's requests fared last, by whose key, as they settled
 * (`ModelLedger.settle`): when one last worked, and when one last failed
 * and how, never what it carried. What an admin reads as a provider's
 * status (core's ai-providers.ts).
 */
export const providerHealth = sqliteTable(
  "provider_health",
  {
    provider: text().notNull(),
    /** `organization` or `platform`. */
    credential: text().notNull(),
    lastOkAt: integer("last_ok_at"),
    lastFailedAt: integer("last_failed_at"),
    /** How it last failed (`TransportFailure`'s kind). */
    lastFailure: text("last_failure"),
    /** The HTTP status it last failed with, if it answered. */
    lastStatus: integer("last_status"),
    /**
     * What its failing requests show, by the HTTP class seen: `refused`,
     * `not_answering` or `limiting` (`ProviderTrouble`); null while the
     * last one worked, and once the organization replaced the key
     * (`ModelLedger.keyReplaced`).
     */
    failingClass: text("failing_class"),
    /** Since when: the first failure of that kind after the last that worked. */
    failingSince: integer("failing_since"),
  },
  (table) => [primaryKey({ columns: [table.provider, table.credential] })]
);

/** Audit events stored with the change they record, until the log has them. */
export const auditOutbox = sqliteTable("audit_outbox", {
  id: text().primaryKey(),
  event: text().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
