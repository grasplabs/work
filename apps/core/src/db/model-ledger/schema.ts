/**
 * The model ledger's Durable Object SQLite (model-ledger.ts): every
 * provider request's reservation and charge, each budget scope's spend,
 * the alerts admins got, and the audit events waiting for the log.
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
  "binding",
  "binding_day",
] as const;

/**
 * One provider request: its unique ID, the receipt that it was admitted,
 * what was reserved for it at its pinned prices, and what it was charged
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
    /** Its scopes, with their limits when admitted, as JSON. */
    scopes: text().notNull(),
    /** `<provider>/<model>`. */
    model: text().notNull(),
    /** The content hash of the prices it is charged at. */
    priceVersion: text("price_version").notNull(),
    /** The prices, as JSON, so no later catalog reprices it. */
    prices: text().notNull(),
    reservedMicros: integer("reserved_micros").notNull(),
    /** What it was charged; null until settled. */
    chargedMicros: integer("charged_micros"),
    /**
     * `dispatched` and `unknown` hold their reservation; `settled` moved it
     * to spend; `quarantined` couldn't be read to settle, and holds it.
     */
    state: text({
      enum: ["dispatched", "unknown", "settled", "quarantined"],
    }).notNull(),
    /**
     * How it settled: by its usage, refused, never sent, or in full; or as
     * a person decided a held request, released or charged.
     */
    settledBy: text("settled_by", {
      enum: ["usage", "refused", "unsent", "reconciled", "released", "charged"],
    }),
    /** Who or what asked, as JSON, for the alerts it causes. */
    actor: text().notNull(),
    dispatchedAt: integer("dispatched_at").notNull(),
    /**
     * When the call is cut off at the latest. Past it, its reservation
     * counts as spent when deciding whether the budget is busy, though it
     * may still settle at what it used until it comes due.
     */
    deadline: integer().notNull().default(0),
    /** When it is charged its whole reservation, unless settled before. */
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
  },
  (table) => [
    check("requests_reserved", sql`${table.reservedMicros} >= 0`),
    check(
      "requests_settled",
      sql`(${table.state} = 'settled') = (${table.chargedMicros} IS NOT NULL AND ${table.chargedMicros} >= 0 AND ${table.settledBy} IS NOT NULL AND ${table.settledAt} IS NOT NULL)`
    ),
    // The reservations still open, soonest due first.
    index("requests_open").on(table.state, table.reconcileAt),
    // Settled requests, oldest first, for the retention sweep.
    index("requests_settled_at").on(table.settledAt),
    // The leases held: requests in flight, by when they end.
    index("requests_leases").on(table.state, table.leaseEndsAt),
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
    index("queue_order").on(table.seenAt, table.turn, table.enqueuedAt),
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
 * The scopes each request reserved against, kept apart from its JSON as
 * the record a person settles it by should that JSON become unreadable
 * (a quarantined request, model-ledger.ts). Swept with its request.
 */
export const requestScopes = sqliteTable(
  "request_scopes",
  {
    requestId: text("request_id").notNull(),
    scope: text({ enum: scopes }).notNull(),
    key: text().notNull(),
    /** Its budget when admitted, for the alerts a decided charge may cause. */
    limitMicros: integer("limit_micros"),
    alertMicros: integer("alert_micros"),
    /** What its alerts name, as JSON. */
    names: text().notNull().default("{}"),
    /**
     * The spend period it reserved against: the request's month, or
     * `lineage` for a run lineage (model-ledger.ts). The request settles,
     * is rebuilt and is summed against exactly this, never one worked out
     * again later. Null for a request admitted before it was recorded,
     * which reserved every scope under its own month (`requests.period`).
     */
    period: text(),
    /** The most requests its scope may admit, when admitted; null for none. */
    limitRequests: integer("limit_requests"),
  },
  (table) => [
    primaryKey({ columns: [table.requestId, table.scope, table.key] }),
    // The requests that reserved against one scope: what holds a run
    // lineage's spend when its rows are pruned, what the requests under way
    // in a full scope hold, and what a damaged scope is rebuilt from
    // (model-ledger.ts).
    index("request_scopes_scope_key").on(table.scope, table.key),
  ]
);

/**
 * What a scope reserved and spent in a month: the deployment, a workflow,
 * a person; or a run lineage, for its whole life, under the period
 * `lineage` (model-ledger.ts). A request reserves against all of its
 * scopes at once, and moves its reservation to the spend when it settles.
 */
export const spend = sqliteTable(
  "spend",
  {
    scope: text({ enum: scopes }).notNull(),
    key: text().notNull(),
    period: text().notNull(),
    reservedMicros: integer("reserved_micros").notNull().default(0),
    spentMicros: integer("spent_micros").notNull().default(0),
    /**
     * How many provider requests it admitted, retries too: one never sent
     * gives its count back. A run lineage's are limited.
     */
    requests: integer().notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.key, table.period] }),
    // A reservation released twice would go below nothing: refused.
    check("spend_reserved", sql`${table.reservedMicros} >= 0`),
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
 * The budget alerts admins got, one per scope, month, kind and threshold
 * value: an alert's event is stored only with a new row here, in the same
 * transaction, so each value alerts once a month.
 */
export const alerts = sqliteTable(
  "alerts",
  {
    scope: text({ enum: scopes }).notNull(),
    key: text().notNull(),
    period: text().notNull(),
    kind: text({ enum: ["alert", "exhausted"] }).notNull(),
    thresholdMicros: integer("threshold_micros").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.scope,
        table.key,
        table.period,
        table.kind,
        table.thresholdMicros,
      ],
    }),
  ]
);

/** Audit events stored with the change they record, until the log has them. */
export const auditOutbox = sqliteTable("audit_outbox", {
  id: text().primaryKey(),
  event: text().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
