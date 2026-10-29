/**
 * Workspace Durable Object SQLite: chats, agent state, and its person's
 * dashboard and email preferences. Migrates itself on first wake-up after a release.
 */
import type { ChatChannel, ChatFileType } from "@grasp-os/shared/chat";
import type { DashboardWidgetId } from "@grasp-os/shared/dashboard";
import type { ChatId } from "@grasp-os/shared/ids";
import type { CustomWidgetId } from "@grasp-os/shared/widgets";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { codeRunStatuses } from "../../code-run-statuses.ts";

export const chats = sqliteTable(
  "chats",
  {
    id: text().$type<ChatId>().primaryKey(),
    title: text().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /**
     * When it last had a message, or was made before it had any: what the
     * person's list goes by, so a chat they just continued comes first.
     */
    lastAt: integer("last_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`0`),
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
    /**
     * The person's project the chat is in (`chatProjects`), or null: its
     * agent reads the project's goal and documents.
     */
    projectId: text("project_id"),
    /**
     * Which channel the chat came through: Grasp's own app (`web`), or a
     * chat platform by its Chat SDK adapter's name (`teams`), which its
     * agent's audit events then name (`via`). Chats made before it was
     * kept are `web`: there was no other.
     */
    via: text().$type<ChatChannel>().notNull().default("web"),
    /**
     * For a chat others share on a chat platform (a group chat, or a
     * channel's thread), the Chat SDK's thread id: the person's one chat
     * for it. Null for the person's own chats, a private one on a chat
     * platform included. Its agent reads only what everyone in it may
     * (`chat_audiences` in core's database).
     */
    thread: text(),
    /**
     * The App the chat is for (`ChatsApi.forApp`): the one its person
     * builds there, which its agent is told of; null for any other chat.
     * Only a pointer: what the agent may do to the App is decided on
     * every call, as for any chat.
     */
    appId: text("app_id"),
  },
  // A person's list, most recently active first.
  (table) => [
    index("chats_person").on(table.personId, table.lastAt),
    index("chats_project").on(table.projectId),
    index("chats_app").on(table.personId, table.appId),
  ]
);

/**
 * A person's projects: a name, and a goal in their own words, which the
 * agent of each chat in it reads, with its documents, as data
 * (`env.chat.project()`), never as its instructions.
 */
export const chatProjects = sqliteTable(
  "chat_projects",
  {
    id: text().primaryKey(),
    /** The person the project belongs to, and the only one who reaches it. */
    personId: text("person_id").notNull(),
    name: text().notNull(),
    goal: text().notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("chat_projects_person").on(table.personId, table.createdAt)]
);

/** A project's text documents, each name once in its project. */
export const chatProjectDocuments = sqliteTable(
  "chat_project_documents",
  {
    id: text().primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => chatProjects.id),
    name: text().notNull(),
    content: text().notNull(),
    /** The content's size, in bytes of UTF-8. */
    bytes: integer().notNull(),
    /**
     * Where it comes in its project: past every document the project had
     * when it was added, so they are read in the order they were added
     * (two quick additions share a time; IDs are random).
     */
    position: integer().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("chat_project_documents_name").on(table.projectId, table.name),
  ]
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
    /**
     * How long the model thought before an answer, in milliseconds
     * (`ChatReasoning.ms`); null for any other message, and for an answer
     * kept before it was timed.
     */
    thinkingMs: integer("thinking_ms"),
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
 * The Knowledge documents a chat's code was given, each once, with the
 * chat's last message when it first was (`givenAfter`, 0 before any): a
 * search's hits, a read's document, and what a follow resolved to a
 * document. What its answers may cite (`ChatCitation`): an answer stored
 * after that message. By message, not by clock, so an answer and a read
 * in the same millisecond keep their order. Written only for a code run
 * that is still open, with its sources (`recordSources` in workspace.ts);
 * at most `chatDocumentsMax` a chat, the oldest dropped.
 */
export const chatDocuments = sqliteTable(
  "chat_documents",
  {
    chatId: text("chat_id")
      .$type<ChatId>()
      .notNull()
      .references(() => chats.id),
    documentId: text("document_id").notNull(),
    givenAfter: integer("given_after").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.documentId] }),
    index("chat_documents_age").on(table.chatId, table.givenAfter),
  ]
);

/**
 * What each code run of a chat read from, each source once a run: the
 * backing of that run's result in the transcript. Before every model
 * request the chat checks each source again, as its agent for its person
 * now, and a result one of whose sources they can no longer read is
 * withheld from the request (`withheldRuns` in workspace.ts).
 * `withheld_at` is when the source was first found unreadable, so each
 * withholding is audited once; cleared once it is readable again. Kept
 * with the chat, not with the run's record (`chat_code_runs` keeps the
 * latest runs only), as long as the transcript holds the result.
 */
export const chatRunSources = sqliteTable(
  "chat_run_sources",
  {
    chatId: text("chat_id")
      .$type<ChatId>()
      .notNull()
      .references(() => chats.id),
    runId: text("run_id").notNull(),
    sourceId: text("source_id").notNull(),
    withheldAt: integer("withheld_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.runId, table.sourceId] }),
  ]
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
    /**
     * The code step (its tool call's ID, `ChatCode.callId`) whose code
     * wrote the draft's latest revision, from the code run's own record
     * (`chat_code_runs`): where the chat's thread shows the draft's
     * preview. Null once its changes are dropped, and for a revision the
     * previous release wrote.
     */
    callId: text("call_id"),
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
 * Every write of a chat's draft of an App, kept as it left the draft and
 * never changed: its `number`, counting up from 1 per chat and App in the
 * order the writes landed, the draft's revision it made, the version it
 * is over (`base`), and the SHA-256 of what it holds (`contentHash`, of
 * the canonical JSON of `base` and each path's content hash). Who wrote
 * it: the chat's agent, in the code step `callId`, or the chat's person,
 * restoring version `restoredFrom`. The draft's row and files hold only
 * the latest; these hold every one, to list, preview and restore. Deleted
 * with the chat, whose drafts they are.
 */
export const chatDraftVersions = sqliteTable(
  "chat_draft_versions",
  {
    chatId: text("chat_id")
      .$type<ChatId>()
      .notNull()
      .references(() => chats.id),
    appId: text("app_id").notNull(),
    number: integer().notNull(),
    revision: integer().notNull(),
    base: integer(),
    contentHash: text("content_hash").notNull(),
    callId: text("call_id"),
    restoredFrom: integer("restored_from"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.appId, table.number] }),
  ]
);

/**
 * What a draft version (`chatDraftVersions`) changes over its base: each
 * path's content by its SHA-256 (`chatDraftContents`), or null to delete
 * the file, a row each.
 */
export const chatDraftVersionFiles = sqliteTable(
  "chat_draft_version_files",
  {
    chatId: text("chat_id").$type<ChatId>().notNull(),
    appId: text("app_id").notNull(),
    number: integer().notNull(),
    path: text().notNull(),
    sha256: text(),
  },
  (table) => [
    primaryKey({
      columns: [table.chatId, table.appId, table.number, table.path],
    }),
    foreignKey({
      columns: [table.chatId, table.appId, table.number],
      foreignColumns: [
        chatDraftVersions.chatId,
        chatDraftVersions.appId,
        chatDraftVersions.number,
      ],
    }),
  ]
);

/**
 * The contents a chat's draft versions of an App name, each once, by its
 * SHA-256: most writes change a file or two, so the versions share the
 * rest.
 */
export const chatDraftContents = sqliteTable(
  "chat_draft_contents",
  {
    chatId: text("chat_id").$type<ChatId>().notNull(),
    appId: text("app_id").notNull(),
    sha256: text().notNull(),
    content: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.appId, table.sha256] }),
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
 * Settled turns' outcomes still owed to the Brain (src/brain-capture.ts),
 * each written in the same transaction as the turn's last message, so a
 * turn never settles without its capture. `facts` is what the turn's end
 * said (how it ended, its model, its answer), identifiers only; the
 * object delivers the rest from the chat when it delivers. Deleted once
 * the Brain has it, or once its chat is deleted; one the Brain refused for
 * good stays `dead`. `seq` only grows (AUTOINCREMENT): the Brain's cursor
 * of this object's turns.
 */
export const brainCaptureIntents = sqliteTable(
  "brain_capture_intents",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    /** The chat the outcome rests on. */
    evidenceId: text("evidence_id").notNull(),
    /** JSON: the turn's end, as `brain-capture.ts` reads it. */
    facts: text().notNull(),
    state: text({ enum: ["pending", "dead"] })
      .notNull()
      .default("pending"),
    attempts: integer().notNull().default(0),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("brain_capture_intents_event_idx").on(table.eventId),
    index("brain_capture_intents_evidence_idx").on(table.evidenceId),
    index("brain_capture_intents_state_idx").on(
      table.state,
      table.attempts,
      table.seq
    ),
  ]
);

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
 * Files the person attached to the chat's questions (`chats.attachFile`):
 * the text core read from each, never the file itself, which nothing
 * keeps. `messageId` is the question that carried it, null while it waits
 * for one. Its agent reads the text through `env.chat.readFile`, as data.
 * Deleted with the chat.
 */
export const chatFiles = sqliteTable(
  "chat_files",
  {
    id: text().primaryKey(),
    chatId: text("chat_id")
      .$type<ChatId>()
      .notNull()
      .references(() => chats.id),
    messageId: integer("message_id").references(() => chatMessages.id),
    name: text().notNull(),
    type: text().$type<ChatFileType>().notNull(),
    /** The file's size, in bytes. */
    bytes: integer().notNull(),
    text: text().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("chat_files_chat").on(table.chatId, table.createdAt)]
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

/**
 * The calls a chat's code made to its agent's APIs, as the chat shows
 * them (`ChatToolEvent` in shared/chat.ts): the code step that made each
 * one, from its run's own record, and the call as JSON: method, target,
 * identifiers and counts, how it ended. Never what a call read. Only the
 * chat's latest `chatToolEventsKept`; deleted with the chat.
 */
export const chatToolEvents = sqliteTable(
  "chat_tool_events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    chatId: text("chat_id")
      .$type<ChatId>()
      .notNull()
      .references(() => chats.id),
    callId: text("call_id").notNull(),
    event: text().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("chat_tool_events_chat").on(table.chatId, table.id)]
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
    widgetId: text("widget_id").$type<DashboardWidgetId>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.personId, table.position] })]
);

/**
 * The widgets Grasp made for a person from what they asked (the shared
 * package's widgets.ts): its spec as JSON, checked as one when it was kept and
 * again when it is read, and what they asked of it last. Its numbers are
 * never kept: they are worked out each time it is shown. Kept in their own
 * Workspace object, as their dashboard is.
 */
export const customWidgets = sqliteTable(
  "custom_widgets",
  {
    personId: text("person_id").notNull(),
    id: text().$type<CustomWidgetId>().notNull(),
    spec: text().notNull(),
    asked: text().notNull(),
    madeAt: integer("made_at", { mode: "timestamp_ms" }).notNull(),
    changedAt: integer("changed_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.personId, table.id] })]
);

/**
 * A person's own choice of the emails Grasp sends them, once they changed
 * it: a row for each person who saved theirs; one never saved gets every
 * email (`defaultEmailPreferences`). Kept in their own Workspace object,
 * as their dashboard is.
 */
export const emailPreferences = sqliteTable("email_preferences", {
  personId: text("person_id").primaryKey(),
  needsYou: integer("needs_you", { mode: "boolean" }).notNull(),
  weeklySummary: integer("weekly_summary", { mode: "boolean" }).notNull(),
  billingProblems: integer("billing_problems", { mode: "boolean" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * The draft release a chat's preview of its draft of an App runs
 * (sealed-previews.ts): the draft sealed at `revision` as the version it
 * would become (`version`), its manifest's canonical text and that text's
 * SHA-256. One per chat and App; replaced when the draft changes, and
 * gone with the draft, its proposal or the chat. Never a version's
 * release: no version is sealed here.
 */
export const previewReleases = sqliteTable(
  "preview_releases",
  {
    chatId: text("chat_id").$type<ChatId>().notNull(),
    appId: text("app_id").notNull(),
    revision: integer().notNull(),
    version: integer().notNull(),
    manifest: text().notNull(),
    manifestHash: text("manifest_hash").notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.appId] })]
);

/**
 * Each artifact a preview's draft release names (`previewReleases`), by
 * the SHA-256 of its bytes: its text, whose UTF-8 bytes are those sealed,
 * read back and checked against that hash at every load.
 */
export const previewReleaseArtifacts = sqliteTable(
  "preview_release_artifacts",
  {
    chatId: text("chat_id").$type<ChatId>().notNull(),
    appId: text("app_id").notNull(),
    sha256: text().notNull(),
    content: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.appId, table.sha256] }),
  ]
);

/**
 * The store each preview of a chat's draft of an App reads and writes, at
 * the draft's `revision` (sealed-previews.ts): a fixture store of the
 * stores' namespace that core's inventory never lists. Recorded before
 * its object is first touched, and forgotten only once it is discarded,
 * so none is lost to a failure in between.
 */
export const previewStores = sqliteTable("preview_stores", {
  storeId: text("store_id").primaryKey(),
  chatId: text("chat_id").$type<ChatId>().notNull(),
  appId: text("app_id").notNull(),
  revision: integer().notNull(),
});
