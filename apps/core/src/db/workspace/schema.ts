/**
 * Workspace Durable Object SQLite: chats, agent state, and its person's
 * dashboard. Migrates itself on first wake-up after a release.
 */
import type { StandardWidgetId } from "@grasp-os/shared/dashboard";
import type { ChatId } from "@grasp-os/shared/ids";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import { codeRunStatuses } from "../../code-run-statuses.ts";

export const chats = sqliteTable(
  "chats",
  {
    id: text().$type<ChatId>().primaryKey(),
    title: text().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** It read restricted data, and is in restricted mode for good. */
    restricted: integer({ mode: "boolean" }).notNull().default(false),
    /**
     * The person the chat belongs to, whom its agent acts for, and the
     * only one who reaches it.
     */
    personId: text("person_id").notNull(),
    /**
     * The agent that answers in the chat, acting for its person: the
     * organization's agent admins grant to, whichever object holds the
     * chat.
     */
    agentId: text("agent_id").notNull(),
  },
  // A person's list, newest first.
  (table) => [index("chats_person").on(table.personId, table.createdAt)]
);

/**
 * A chat's transcript, in order: the agent's messages as pi shapes them
 * (system, user, assistant and tool results), as JSON. A message is stored
 * when the loop finishes it, so a turn cut short keeps its finished steps.
 */
export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    chatId: text("chat_id")
      .$type<ChatId>()
      .notNull()
      .references(() => chats.id),
    message: text().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("chat_messages_chat").on(table.chatId, table.id)]
);

/**
 * What a chat's agent has read from, each source once: the collections and
 * connections its code read through the chat's APIs, and, for a chat
 * started to fix a failed run, the run and its App's sources. Every model
 * request of the chat carries all of them as provenance, so the client's
 * model rules judge a later turn by what an earlier one read. Written only
 * for a code run that is still open (`recordSources` in workspace.ts), or
 * with the chat that attaches a run's report (`createChat`).
 */
export const chatSources = sqliteTable(
  "chat_sources",
  {
    chatId: text("chat_id")
      .$type<ChatId>()
      .notNull()
      .references(() => chats.id),
    sourceId: text("source_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.sourceId] })]
);

/**
 * A chat's drafts: one per App its agent writes to, over the version it
 * started from (`base`, null for an App with none). A draft is the chat's
 * own: it reaches the App only when the agent proposes it as a version
 * (agent-builds.ts). Each write is
 * a new `revision`, and lands only over the revision it read. A draft
 * whose changes are all gone (proposed, discarded, or written back as the
 * base has them) keeps its row, and its revision: it has no changes, and
 * its next write starts over the App's latest version.
 */
export const chatDrafts = sqliteTable(
  "chat_drafts",
  {
    chatId: text("chat_id")
      .$type<ChatId>()
      .notNull()
      .references(() => chats.id),
    appId: text("app_id").notNull(),
    base: integer(),
    revision: integer().notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.appId] })]
);

/**
 * A draft's changes (`chatDrafts`): a file's new content by path, or null
 * to delete it, a row each, so no row holds more than one file.
 */
export const chatDraftFiles = sqliteTable(
  "chat_draft_files",
  {
    chatId: text("chat_id").$type<ChatId>().notNull(),
    appId: text("app_id").notNull(),
    path: text().notNull(),
    content: text(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.appId, table.path] }),
    foreignKey({
      columns: [table.chatId, table.appId],
      foreignColumns: [chatDrafts.chatId, chatDrafts.appId],
    }),
  ]
);

/**
 * Audit events of changes to this object's chats (made, renamed, deleted,
 * started to fix a failed run, restricted from the start),
 * each stored in the same transaction as its change, until the object has
 * delivered it to the audit log (`drainObjectOutbox` in audit-outbox.ts).
 */
export const auditOutbox = sqliteTable("audit_outbox", {
  id: text().primaryKey(),
  event: text().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * What a chat was started with, besides its question: for now, the
 * failure report of the workflow run the person asked its agent to fix
 * (`chats.fixRun` in chats-rpc.ts), as JSON. Its agent reads it through
 * `env.chat.attachments()`, as data: the report's message is the
 * workflow's own text, and never goes into the agent's instructions.
 */
export const chatAttachments = sqliteTable(
  "chat_attachments",
  {
    chatId: text("chat_id")
      .$type<ChatId>()
      .notNull()
      .references(() => chats.id),
    runId: text("run_id").notNull(),
    report: text().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.runId] })]
);

/**
 * Every code run of a chat's agent, as evidence of what ran and how it
 * ended: its run ID (the lease its stubs answer to, random and never
 * reused), the tool call it ran for, the SHA-256 and length of its module
 * (never the module itself: the transcript has the call), the agent and
 * runtime it ran on, whether that runtime enforces the CPU limit, and its
 * status: `running` until it ends, then how it ended (`CodeRunStatus` in
 * code-mode.ts), or `interrupted` when a restart ended it first. Nothing
 * here is ever run again: a restart ends a run's lease, and the agent's
 * next step is a new run with a new ID. Deleted with the chat.
 */
/** Most characters of a tool call's ID a run's record keeps. */
export const maxToolCallIdChars = 200;

export const chatCodeRuns = sqliteTable(
  "chat_code_runs",
  {
    id: text().primaryKey(),
    chatId: text("chat_id")
      .$type<ChatId>()
      .notNull()
      .references(() => chats.id),
    toolCallId: text("tool_call_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    sourceChars: integer("source_chars").notNull(),
    agent: text().notNull(),
    compatibilityDate: text("compatibility_date").notNull(),
    runtime: text({ enum: ["cloudflare", "workerd"] }).notNull(),
    cpuLimit: text("cpu_limit", {
      enum: ["enforced", "cpu_limit_unsupported"],
    }).notNull(),
    status: text({ enum: ["running", ...codeRunStatuses] }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("chat_code_runs_chat").on(table.chatId, table.startedAt),
    // The runs a wake marks interrupted: few, found without a scan.
    index("chat_code_runs_running")
      .on(table.status)
      .where(sql`status = 'running'`),
    check(
      "chat_code_runs_status",
      sql`${table.status} IN (${sql.raw(
        ["running", ...codeRunStatuses]
          .map((status) => `'${status}'`)
          .join(", ")
      )})`
    ),
    check(
      "chat_code_runs_tool_call_id",
      sql`length(${table.toolCallId}) BETWEEN 1 AND ${sql.raw(String(maxToolCallIdChars))}`
    ),
  ]
);

/** The kinds of build a chat's code can hand to a durable job. */
export const buildJobKinds = ["check", "propose"] as const;

/**
 * How a build job ended, as the host records it: it ran to its end
 * (`completed`, whatever its check found), stopped on an error
 * (`failed`), the person cancelled its turn or deleted its chat
 * (`cancelled`), or a permission of the agent was revoked since the run
 * that submitted it opened (`revoked`).
 */
export const buildJobStatuses = [
  "completed",
  "failed",
  "cancelled",
  "revoked",
] as const;

/**
 * A build a chat's code handed to a durable job (build-jobs.ts): a check
 * or a proposal of the chat's draft of an App, run as a workflow of core's
 * own, so it outlives the code run that submitted it. Its ID is the
 * workflow instance's, random. It acts on the authority the submitting run
 * had and no more: the chat's agent for the chat's person, read again at
 * every step, and only while no permission of the agent was revoked since
 * `grantedAt` (when that run opened). It is bound to the draft's
 * `revision` then, the turn it was submitted in (`turnId`, which alone
 * hears how it ended) and the run (`runId`, evidence only: nothing runs
 * the run's code again). `running` until it ends; then how it ended, the
 * result it hands on (none once revoked), and the version it proposed,
 * its receipt, which stays whatever happens after. `intendedTree` is the
 * tree it is about to commit over `intendedParent`: what a commit step
 * run again reconciles with, rather than committing twice. Deleted with
 * the chat.
 */
export const chatBuildJobs = sqliteTable(
  "chat_build_jobs",
  {
    id: text().primaryKey(),
    chatId: text("chat_id")
      .$type<ChatId>()
      .notNull()
      .references(() => chats.id),
    turnId: text("turn_id").notNull(),
    runId: text("run_id").notNull(),
    appId: text("app_id").notNull(),
    kind: text({ enum: buildJobKinds }).notNull(),
    message: text(),
    revision: integer().notNull(),
    grantedAt: integer("granted_at", { mode: "timestamp_ms" }).notNull(),
    status: text({ enum: ["running", ...buildJobStatuses] }).notNull(),
    result: text(),
    error: text(),
    intendedParent: integer("intended_parent"),
    intendedTree: text("intended_tree"),
    version: integer(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("chat_build_jobs_chat").on(table.chatId, table.createdAt),
    check(
      "chat_build_jobs_status",
      sql`${table.status} IN (${sql.raw(
        ["running", ...buildJobStatuses]
          .map((status) => `'${status}'`)
          .join(", ")
      )})`
    ),
    check(
      "chat_build_jobs_kind",
      sql`${table.kind} IN (${sql.raw(
        buildJobKinds.map((kind) => `'${kind}'`).join(", ")
      )})`
    ),
  ]
);

/**
 * A person's own dashboard, once they changed it: a row for each person
 * who saved one, so a board they took every widget off reads as empty,
 * and one never saved as none (the board as it begins). Kept in their
 * own Workspace object (`personalWorkspaceId` in chats-rpc.ts).
 */
export const dashboards = sqliteTable("dashboards", {
  personId: text("person_id").primaryKey(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * The widgets on a person's dashboard (`dashboards`), a row each, in
 * order of `position` from 0. Saving replaces them all.
 */
export const dashboardWidgets = sqliteTable(
  "dashboard_widgets",
  {
    personId: text("person_id")
      .notNull()
      .references(() => dashboards.personId),
    position: integer().notNull(),
    widgetId: text("widget_id").$type<StandardWidgetId>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.personId, table.position] })]
);
