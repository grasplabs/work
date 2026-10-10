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
const scopes = ["deployment", "workflow", "user", "run"] as const;

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
    /** How it settled: by its usage, refused, never sent, or in full. */
    settledBy: text("settled_by", {
      enum: ["usage", "refused", "unsent", "reconciled", "decided"],
    }),
    /** Who or what asked, as JSON, for the alerts it causes. */
    actor: text().notNull(),
    dispatchedAt: integer("dispatched_at").notNull(),
    /** When it is charged its whole reservation, unless settled before. */
    reconcileAt: integer("reconcile_at").notNull(),
    settledAt: integer("settled_at"),
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
  },
  (table) => [
    primaryKey({ columns: [table.requestId, table.scope, table.key] }),
  ]
);

/**
 * What a scope reserved and spent in a month: the deployment, a workflow,
 * a person or a run. A request reserves against all of its scopes at
 * once, and moves its reservation to the spend when it settles.
 */
export const spend = sqliteTable(
  "spend",
  {
    scope: text({ enum: scopes }).notNull(),
    key: text().notNull(),
    period: text().notNull(),
    reservedMicros: integer("reserved_micros").notNull().default(0),
    spentMicros: integer("spent_micros").notNull().default(0),
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
