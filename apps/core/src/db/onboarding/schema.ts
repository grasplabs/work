/**
 * The onboarding's Durable Object SQLite (onboarding/store.ts): one per
 * deployment. Migrates itself on first wake-up after a release.
 */
import { sql } from "drizzle-orm";
import {
  check,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * The onboarding as a whole, one row: the plan, the agreements, and
 * whether Grasp paused the interviews. A plan, once saved, is what links
 * go out by.
 */
export const onboarding = sqliteTable(
  "onboarding",
  {
    id: integer().primaryKey(),
    /** The plan as JSON (`planSchema`), or `null` before there is one. */
    plan: text(),
    /** The agreements as JSON (`agreementsSchema`), or `null` before any. */
    agreements: text(),
    /** When Grasp paused the interviews (ISO 8601); `null` while they run. */
    pausedAt: text("paused_at"),
  },
  (table) => [check("onboarding_one_row", sql`${table.id} = 1`)]
);

/** The teams, in the order the admin gave them. */
export const teams = sqliteTable("teams", {
  id: text().primaryKey(),
  position: integer().notNull(),
  name: text().notNull(),
  /** Its lead, by person. */
  lead: text(),
  does: text().notNull(),
  off: integer({ mode: "boolean" }).notNull(),
  /**
   * When its lead's map of the team's work was drawn (ISO 8601): its links
   * wait for that, or for `leadWaitWorkingDays`.
   */
  mappedAt: text("mapped_at"),
});

/** The people, in the order the admin gave them. */
export const people = sqliteTable("people", {
  id: text().primaryKey(),
  position: integer().notNull(),
  name: text().notNull(),
  email: text().notNull(),
  team: text().notNull(),
  title: text().notNull(),
  away: integer({ mode: "boolean" }).notNull(),
});

/**
 * Each person's link, once it went out: when, and when it was opened and
 * reminded about. A person without a row has no link out yet.
 */
export const links = sqliteTable("links", {
  person: text().primaryKey(),
  sentAt: text("sent_at").notNull(),
  openedAt: text("opened_at"),
  remindedAt: text("reminded_at"),
});

/**
 * Where each interview stands, without anything that was said in it: all
 * the plan, the links and the numbers need, so a change never reads every
 * interview.
 */
export const interviewStates = sqliteTable("interview_states", {
  person: text().primaryKey(),
  kind: text({ enum: ["own", "lead"] }).notNull(),
  startedAt: text("started_at"),
  /** When they first agreed to what was read back (ISO 8601). */
  completedAt: text("completed_at"),
  updatedAt: text("updated_at").notNull(),
});

/**
 * What happened in the onboarding, and who did it: Grasp's staff, the
 * company's admin, or Grasp itself. Ids and counts only, never anyone's
 * words.
 */
export const events = sqliteTable("events", {
  seq: integer().primaryKey({ autoIncrement: true }),
  at: text().notNull(),
  by: text().notNull(),
  what: text().notNull(),
  about: text(),
});

/**
 * The AI the onboarding used, by day, purpose and model: calls, tokens
 * read new and from a cache, tokens written, and seconds of voice.
 */
export const usage = sqliteTable(
  "usage",
  {
    day: text().notNull(),
    purpose: text().notNull(),
    model: text().notNull(),
    calls: integer().notNull(),
    tokensIn: integer("tokens_in").notNull(),
    tokensCached: integer("tokens_cached").notNull(),
    tokensOut: integer("tokens_out").notNull(),
    seconds: real().notNull(),
  },
  (table) => [primaryKey({ columns: [table.day, table.purpose, table.model] })]
);

/**
 * Audit events of changes here, each stored in the same transaction as its
 * change, until the object has delivered it to the audit log
 * (`drainObjectOutbox` in audit-outbox.ts).
 */
export const auditOutbox = sqliteTable("audit_outbox", {
  id: text().primaryKey(),
  event: text().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
