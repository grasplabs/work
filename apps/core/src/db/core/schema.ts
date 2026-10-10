import type {
  AgentProposer,
  AppExports,
  AppRecordTypes,
} from "@grasp-os/shared/apps";
import { auditRejectReasons } from "@grasp-os/shared/audit";
import type { DependencySummary } from "@grasp-os/shared/dependencies";
import type { Json } from "@grasp-os/shared/json";
import type { DeclaredPermission } from "@grasp-os/shared/permissions";
import { artifactDecisions } from "@grasp-os/shared/screen-trust";
import { signalKinds } from "@grasp-os/shared/signals";
import type {
  EventFilter,
  ParamValue,
  RunFailure,
  WorkflowCalls,
} from "@grasp-os/shared/workflows";
/**
 * Core D1 database: identity (Better Auth), permissions and the App registry.
 *
 * The identity tables are the ones Better Auth and its organization and SSO
 * plugins expect (`src/auth/auth.ts` maps them by these export names), with
 * plural table names and snake_case columns. Better Auth fills ids and
 * timestamps itself.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

/** A person. Found by their IdP account, never by email alone. */
export const users = sqliteTable("users", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
  image: text(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/** A signed-in browser. The cookie holds the token; revoking deletes the row. */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    activeOrganizationId: text("active_organization_id"),
    activeTeamId: text("active_team_id"),
    /** A Grasp staff session: time-bound, and not a member of the organization. */
    staff: integer({ mode: "boolean" }).notNull().default(false),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)]
);

/**
 * A person's identity at an IdP: the provider and its stable subject. Sign-in
 * tokens are never stored here (see `src/auth/auth.ts`); the columns exist
 * because Better Auth's model has them.
 */
export const accounts = sqliteTable(
  "accounts",
  {
    id: text().primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text(),
    password: text(),
    /**
     * The Entra object id (`oid`) from the ID token of the latest sign-in,
     * so staff sessions can be checked against the current staff list.
     */
    oid: text(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    index("accounts_user_id_idx").on(table.userId),
    uniqueIndex("accounts_provider_account_idx").on(
      table.providerId,
      table.accountId
    ),
  ]
);

/** Short-lived values, such as the state of a sign-in in progress. */
export const verifications = sqliteTable(
  "verifications",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)]
);

/** The deployment's one organization. */
export const organizations = sqliteTable("organizations", {
  id: text().primaryKey(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  logo: text(),
  metadata: text(),
  createdAt: timestamp("created_at").notNull(),
});

/** A person's place in the organization, with their role. */
export const members = sqliteTable(
  "members",
  {
    id: text().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text().notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("members_organization_user_idx").on(
      table.organizationId,
      table.userId
    ),
    index("members_user_id_idx").on(table.userId),
  ]
);

/**
 * People an admin removed from the organization. Everyone else from the
 * client's IdP gets a membership when they sign in if they have none (also
 * repairing one whose creation failed); a removal recorded here keeps them
 * out. Kept apart from `members`, whose rows the organization plugin treats
 * as live memberships. Who removed them is in the audit log.
 */
export const memberRemovals = sqliteTable(
  "member_removals",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    removedAt: timestamp("removed_at").notNull(),
    /**
     * When connect completed disconnecting their personal connections;
     * until then the cron trigger retries it (`retryDisconnects`).
     */
    disconnectedAt: timestamp("disconnected_at"),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })]
);

/**
 * Part of the organization plugin's model. Invitations aren't offered: people
 * join by signing in with the deployment's IdP.
 */
export const invitations = sqliteTable(
  "invitations",
  {
    id: text().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text().notNull(),
    role: text(),
    teamId: text("team_id"),
    status: text().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitations_organization_id_idx").on(table.organizationId),
    index("invitations_email_idx").on(table.email),
  ]
);

export const teams = sqliteTable(
  "teams",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    memberCount: integer("member_count").notNull().default(0),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [index("teams_organization_id_idx").on(table.organizationId)]
);

export const teamMembers = sqliteTable(
  "team_members",
  {
    id: text().primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    membershipKey: text("membership_key").unique(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("team_members_team_id_idx").on(table.teamId),
    index("team_members_user_id_idx").on(table.userId),
  ]
);

/**
 * Part of the SSO plugin's model, and stays empty: sign-in providers come
 * only from deployment config, and registering one in-product is refused.
 */
export const ssoProviders = sqliteTable("sso_providers", {
  id: text().primaryKey(),
  issuer: text().notNull(),
  oidcConfig: text("oidc_config"),
  samlConfig: text("saml_config"),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull().unique(),
  organizationId: text("organization_id"),
  domain: text().notNull(),
});

/**
 * Audit events of changes to this database that haven't reached the audit
 * log yet. Each is written in the same batch as its change, so a change is
 * never kept without its event; `src/audit-outbox.ts` appends them to the
 * log and removes them. `event` is the event as JSON.
 */
export const auditOutbox = sqliteTable("audit_outbox", {
  id: text().primaryKey(),
  event: text().notNull(),
  createdAt: timestamp("created_at").notNull(),
});

/**
 * Outbox rows a drain moved out because the audit log can't take them:
 * `refused` (not an event to the release that drained it, or over the size
 * cap) or `conflict` (the log holds its ID with other content, a bug or a
 * forgery). Kept as they were, for someone to look at; the chain records
 * each with an `audit.gap` naming its ID and reason (src/audit-outbox.ts in
 * core). Nothing reads them.
 */
export const auditOutboxRejected = sqliteTable(
  "audit_outbox_rejected",
  {
    // Its own key, so a second row with the same event ID is kept too.
    seq: integer().primaryKey(),
    id: text().notNull(),
    event: text().notNull(),
    reason: text({ enum: auditRejectReasons }).notNull(),
    /** When the row was stored in the outbox. */
    createdAt: timestamp("created_at").notNull(),
    rejectedAt: timestamp("rejected_at").notNull(),
  },
  (table) => [index("audit_outbox_rejected_id").on(table.id)]
);

/**
 * What each App and agent may use: one row per permission, never deleted,
 * so who asked, who granted and who revoked stays readable. Only its status
 * and the grant and revoke columns ever change.
 *
 * The object is stored by type: a connection is `object_id`, with
 * `resource` naming one resource in it or null for all of it; a collection
 * is `object_id`; a workflow is its App's ID in `object_id` and the
 * workflow's in `resource`; another App's exports are that App's ID in
 * `object_id`. `actions` is a JSON array of action names.
 */
export const permissions = sqliteTable(
  "permissions",
  {
    id: text().primaryKey(),
    subjectType: text("subject_type", { enum: ["app", "agent"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    objectType: text("object_type", {
      enum: ["connection", "collection", "workflow", "app", "platform"],
    }).notNull(),
    objectId: text("object_id").notNull(),
    resource: text(),
    actions: text().notNull(),
    binding: text().notNull(),
    status: text({ enum: ["requested", "active", "revoked"] }).notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at").notNull(),
    grantedBy: text("granted_by"),
    grantedAt: timestamp("granted_at"),
    revokedBy: text("revoked_by"),
    revokedAt: timestamp("revoked_at"),
    /**
     * The chat's agent that asked for it, for `requested_by` (JSON,
     * `AgentProposer`); null when the person asked themselves. A row the
     * previous release writes gets none.
     */
    requestedVia: text("requested_via", {
      mode: "json",
    }).$type<AgentProposer>(),
    /**
     * The one chat an agent's permission holds in (chat-connections.ts),
     * by its ID (a random UUID, unique across Workspace objects), and only
     * for its `requested_by`. Null for a permission that holds wherever
     * its subject works.
     */
    chatId: text("chat_id"),
    /** Why the chat's agent asked for it, in its words; null otherwise. */
    reason: text(),
    /**
     * A chat's request for its person's own personal connection: only
     * they see and decide it, never an admin. A connection's owner never
     * changes, so this is read from connect once, as it is asked for.
     */
    personal: integer({ mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    index("permissions_subject_idx").on(
      table.subjectType,
      table.subjectId,
      table.status
    ),
    // The Apps granted to call an App's exports, found from that App
    // (app-provenance.ts): by object, not subject.
    index("permissions_object_idx").on(table.objectType, table.objectId),
    // A binding name is one stub in the subject's env, so it is unique
    // among the permissions that aren't revoked: those that hold anywhere,
    // and within each chat, those that hold in it alone.
    uniqueIndex("permissions_live_binding_idx")
      .on(table.subjectType, table.subjectId, table.binding)
      .where(sql`status <> 'revoked' AND chat_id IS NULL`),
    uniqueIndex("permissions_live_chat_binding_idx")
      .on(table.chatId, table.subjectType, table.subjectId, table.binding)
      .where(sql`status <> 'revoked' AND chat_id IS NOT NULL`),
  ]
);

/**
 * The App registry. Each App's code is a series of versions
 * (`app_versions`); `current_version` is the one that runs and
 * `pending_version` one put up for review. Both only ever name a version
 * the App has.
 */
export const apps = sqliteTable("apps", {
  id: text().primaryKey(),
  name: text().notNull(),
  description: text().notNull(),
  /** The user who created it. */
  ownerId: text("owner_id").notNull(),
  blueprint: text(),
  currentVersion: integer("current_version"),
  pendingVersion: integer("pending_version"),
  createdAt: timestamp("created_at").notNull(),
});

/**
 * Whom each App is shared with (src/app-access.ts): a person
 * (`member_type` `person`, `member_id` their user ID) or a team, with their
 * role in it. Sharing again changes the role; unsharing deletes the row.
 * Who did which is in the audit log. The App's owner has no row: they are
 * always one of its builders.
 */
export const appMembers = sqliteTable(
  "app_members",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    memberType: text("member_type", { enum: ["person", "team"] }).notNull(),
    memberId: text("member_id").notNull(),
    role: text({ enum: ["user", "builder"] }).notNull(),
    addedBy: text("added_by").notNull(),
    addedAt: timestamp("added_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.appId, table.memberType, table.memberId] }),
    // Which Apps are shared with someone, for listing theirs.
    index("app_members_member_idx").on(table.memberType, table.memberId),
  ]
);

/**
 * What an admin decided about one exact build of an App's screen
 * (src/screen-trust.ts): `artifact` is the SHA-256 of the code a frame is
 * handed, so other code, other packages or another kit is another row.
 * A row is written only by a decision: `approved` when an admin approves
 * a version's screens, `revoked` when one takes that back; it keeps who
 * made the last one and when. A build with no row is nobody's decision
 * (`unreviewed`); what waits for an admin is worked out from the current
 * versions' builds, never recorded. `version` and `screen` say where the
 * build was first decided on: the same code in a later version is the
 * same row. Rows are never deleted.
 */
export const screenArtifacts = sqliteTable(
  "screen_artifacts",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    artifact: text().notNull(),
    version: integer().notNull(),
    screen: text().notNull(),
    status: text({ enum: artifactDecisions }).notNull(),
    decidedBy: text("decided_by").notNull(),
    decidedAt: timestamp("decided_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.appId, table.artifact] })]
);

/**
 * What each screen of an App's version builds to with a release's kit
 * (`release`, the compiler version): its hash, recorded where builds
 * happen anyway (src/screen-builds.ts), so what waits for an admin is a
 * query, never a build. The same files build the same way with the same
 * release, so a row never changes; one for another release is another row.
 */
export const screenBuilds = sqliteTable(
  "screen_builds",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    version: integer().notNull(),
    release: text().notNull(),
    screen: text().notNull(),
    artifact: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.appId, table.version, table.release, table.screen],
    }),
  ]
);

/**
 * An App's policy for its screens, one row per App once anything set it
 * (none yet is `sensitive`, generation 0): what its data is to them
 * (`output`), and a generation that goes up, in the batch that makes the
 * change, with every approval, revocation and change of `output`. An
 * approval lands only under the generation its admin reviewed.
 */
export const screenPolicies = sqliteTable("screen_policies", {
  appId: text("app_id")
    .primaryKey()
    .references(() => apps.id),
  output: text({ enum: ["sensitive", "ordinary"] }).notNull(),
  generation: integer().notNull(),
});

/**
 * Blueprints (src/app-blueprints.ts), to create Apps from: code (`tree`,
 * a marked one's its version's, a built-in's stored as a version's files
 * are), and what each App created
 * from it asks for. One is a version of an App a builder marked (`app_id`
 * and `version`, at most one per version), or one the release ships
 * (`blueprints/` in core), which has neither and is changed only by the
 * install. Unmarking deletes the row; who marked, unmarked or installed
 * which is in the audit log.
 */
export const blueprints = sqliteTable(
  "blueprints",
  {
    /** Random for a marked version; a built-in's folder name. */
    id: text().primaryKey(),
    name: text().notNull(),
    description: text().notNull(),
    tree: text().notNull(),
    appId: text("app_id").references(() => apps.id),
    version: integer(),
    /**
     * Whether an admin approved its code: a copy's first version is
     * approved only then (`madeCurrent`).
     */
    approved: integer({ mode: "boolean" }).notNull(),
    /**
     * What each App created from it asks for (JSON, `DeclaredPermission[]`),
     * each waiting for an admin there.
     */
    permissions: text({ mode: "json" }).$type<DeclaredPermission[]>().notNull(),
    /** Who marked it; null for a built-in. */
    markedBy: text("marked_by"),
    /** When it was marked, or last installed changed. */
    markedAt: timestamp("marked_at").notNull(),
  },
  (table) => [
    uniqueIndex("blueprints_app_version_idx").on(table.appId, table.version),
  ]
);

/**
 * Every committed version of an App, never changed or deleted. `tree` is
 * the SHA-256 of the version's files, which are stored under it in R2
 * (`src/apps.ts`). Versions count up from 1 per App, and the primary key
 * makes two commits of the same version conflict instead of both landing.
 */
export const appVersions = sqliteTable(
  "app_versions",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    version: integer().notNull(),
    parent: integer(),
    tree: text().notNull(),
    files: integer().notNull(),
    authorId: text("author_id").notNull(),
    message: text().notNull(),
    createdAt: timestamp("created_at").notNull(),
    /**
     * Whether an admin approved this version's code for the App's
     * permissions to change things with (permissions.ts, `authorize`): 1
     * once an admin made it current or granted a permission while it was,
     * or it is an App's first version copied from a blueprint; 0 once
     * someone who couldn't grant made it current, until then. Null for a
     * version made current before this column, which counts as approved,
     * and for one never made current, which never runs.
     */
    approved: integer(),
    /**
     * The IDs of the version's workflows (JSON), written when it is
     * committed, as a version never changes: so listing an App's
     * workflows reads no files (workflows/overview.ts). A row the
     * previous release writes gets none (the default).
     */
    workflows: text({ mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    /**
     * The App's bindings each of the version's workflows calls, by
     * workflow ID (JSON, `WorkflowCalls`), written when it is committed
     * from the same reading its review shows: a run's calls are held to
     * it (workflows/host.ts). A workflow it keeps no entry for doesn't run
     * (`workflow.calls_not_kept`), and its review shows no calls.
     */
    workflowCalls: text("workflow_calls", { mode: "json" })
      .$type<Record<string, WorkflowCalls>>()
      .notNull()
      .default(sql`'{}'`),
    /**
     * The version's exports (JSON, `AppExports`), read from its
     * `app/exports.json` when it is committed (app-exports.ts): so a call
     * from another App reads no files to find what it may call.
     */
    exports: text({ mode: "json" })
      .$type<AppExports>()
      .notNull()
      .default(sql`'{}'`),
    /**
     * The chat's agent that wrote and proposed it, for `author_id` (JSON,
     * `AgentProposer`); null for a version a person committed. A row the
     * previous release writes gets none.
     */
    proposedBy: text("proposed_by", { mode: "json" }).$type<AgentProposer>(),
    /**
     * The version's record types (JSON, `AppRecordTypes`), read from its
     * `app/records.json` when it is committed (app-records.ts): so a save
     * to Knowledge reads no files to find the types it is checked against.
     */
    records: text({ mode: "json" })
      .$type<AppRecordTypes>()
      .notNull()
      .default(sql`'{}'`),
  },
  (table) => [primaryKey({ columns: [table.appId, table.version] })]
);

/**
 * Which App a record type in a collection (a Knowledge collection, by ID)
 * belongs to: the first whose declaration took effect there
 * (knowledge/record-types.ts). Claimed when an App's write permission on
 * the collection is granted or its version is made current, and kept
 * while that App may write there with a version that declares the type;
 * another App claims it only once it no longer does.
 */
export const recordTypeOwners = sqliteTable(
  "record_type_owners",
  {
    collectionId: text("collection_id").notNull(),
    type: text().notNull(),
    appId: text("app_id").notNull(),
    claimedAt: timestamp("claimed_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.collectionId, table.type] })]
);

/**
 * Every run of an App's workflow (src/workflows/): the App version it is
 * pinned to, and who it acts for. A run a person started acts for them
 * (`started_by`); one a trigger started (`started_by` null) for the App's
 * owner. Cloudflare Workflows keeps the run's steps; this row is what core
 * needs to load it again, and lists runs. `status` is where the run was
 * last seen by core: `running` covers waiting too. `failure` is a failed
 * run's report (JSON): where and why it stopped, without the values it
 * worked on.
 *
 * `details_removed_at` is when an ended run's details were removed, its
 * retention over (workflows/retention.ts): the engine's record of it (its
 * input, what its steps returned, its output), the message of its
 * `failure` and the key of the step that names, and what its decisions
 * asked and were answered, with the keys of their steps. The row itself
 * stays, so the run is still listed, counted and found by the
 * audit log's events of it, and its trigger key still stands for it.
 */
export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text().primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    workflowId: text("workflow_id").notNull(),
    version: integer().notNull(),
    startedBy: text("started_by"),
    status: text({
      // `starting`: written, its engine instance not yet known to exist
      // (src/workflows/runs.ts, `startRun`).
      enum: [
        "starting",
        "running",
        "paused",
        "completed",
        "failed",
        "cancelled",
      ],
    }).notNull(),
    createdAt: timestamp("created_at").notNull(),
    endedAt: timestamp("ended_at"),
    failure: text({ mode: "json" }).$type<RunFailure>(),
    /**
     * What a trigger started it for (src/workflows/triggers.ts): one key
     * per scheduled time, so the same one delivered twice starts one run.
     * Null for a run a person started, and for one whose start failed,
     * which gives its key up for the delivery tried again.
     */
    triggerKey: text("trigger_key"),
    detailsRemovedAt: timestamp("details_removed_at"),
  },
  (table) => [
    index("workflow_runs_app_idx").on(table.appId, table.createdAt),
    // Runs across Apps, newest first: the Workflows page's Runs tab
    // (src/workflows/overview.ts).
    index("workflow_runs_created_idx").on(table.createdAt, table.id),
    // An App's runs of one workflow, newest first: what its screens list.
    index("workflow_runs_app_workflow_idx").on(
      table.appId,
      table.workflowId,
      table.createdAt
    ),
    // The improvement signals (src/signals.ts): runs that failed in a
    // window, latest first. Runs started in one are counted per App
    // workflow by the index above.
    index("workflow_runs_status_ended_idx").on(
      table.status,
      table.endedAt,
      table.id
    ),
    uniqueIndex("workflow_runs_trigger_key_idx").on(table.triggerKey),
    // The retention sweep (src/workflows/retention.ts): ended runs that
    // still have their details, longest ended first, then by ID, which
    // the sweep pages by. Only those: a live run has no `ended_at`, and a
    // swept one leaves the index.
    index("workflow_runs_details_kept_idx")
      .on(table.endedAt, table.id)
      .where(sql`ended_at IS NOT NULL AND details_removed_at IS NULL`),
  ]
);

/**
 * The triggers of the workflows in each App's current version
 * (src/workflows/trigger-registry.ts), written when a version is made
 * current and removed when another is. `position` is the trigger's place
 * among its workflow's. A schedule keeps its cron expression as its
 * parameter holds it now (`cron`), in its time zone, when it next
 * fires (`next_run_at`), and how many starts of its run have failed in a
 * row (`failed_starts`): at `maxFailedStarts` it stops, with no next time
 * (src/workflows/triggers.ts). An email trigger keeps the address it receives
 * mail at (`address`, the part before the `@`); an event trigger its event
 * type (`event`) and filter (`filter`, JSON).
 */
export const workflowTriggers = sqliteTable(
  "workflow_triggers",
  {
    id: text().primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    version: integer().notNull(),
    workflowId: text("workflow_id").notNull(),
    position: integer().notNull(),
    type: text({ enum: ["schedule", "email", "event"] }).notNull(),
    param: text(),
    cron: text(),
    timeZone: text("time_zone"),
    nextRunAt: timestamp("next_run_at"),
    createdAt: timestamp("created_at").notNull(),
    address: text(),
    event: text(),
    filter: text({ mode: "json" }).$type<EventFilter>(),
    failedStarts: integer("failed_starts").notNull().default(0),
  },
  (table) => [
    uniqueIndex("workflow_triggers_position_idx").on(
      table.appId,
      table.version,
      table.workflowId,
      table.position
    ),
    index("workflow_triggers_next_run_idx").on(table.nextRunAt),
    index("workflow_triggers_address_idx").on(table.address),
    index("workflow_triggers_event_idx").on(table.event),
  ]
);

/**
 * Every decision a workflow run waits for (`step.decision`, src/decisions/),
 * one per run and step: who answers it (`deciders`: `person:<id>`,
 * `role:<role>` or `team:<id>`), until when (`expires_at`), and how it
 * ended. `status` moves from `open` once, in one conditional update, to an
 * answer (`approved`, `rejected`) or `timed_out`, so the first answer is
 * the only one. An answer keeps who gave it, when, and the payload they
 * sent (JSON), which the run gets.
 */
export const workflowDecisions = sqliteTable(
  "workflow_decisions",
  {
    id: text().primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id),
    step: text().notNull(),
    deciders: text().notNull(),
    description: text().notNull(),
    status: text({
      enum: ["open", "approved", "rejected", "timed_out"],
    }).notNull(),
    openedAt: timestamp("opened_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at"),
    payload: text({ mode: "json" }).$type<Json>(),
  },
  (table) => [
    uniqueIndex("workflow_decisions_run_step_idx").on(table.runId, table.step),
    // A run's open decisions (src/workflows/overview.ts): whether it waits.
    index("workflow_decisions_run_status_idx").on(table.runId, table.status),
    // The improvement signals (src/signals.ts): open decisions, oldest
    // first, and decisions answered in a window, latest first.
    index("workflow_decisions_status_opened_idx").on(
      table.status,
      table.openedAt,
      table.id
    ),
    index("workflow_decisions_decided_idx").on(table.decidedAt, table.id),
  ]
);

/**
 * npm packages proposed for an App (src/dependencies/requests.ts), one row
 * per request. What was asked never changes: the App, where the packages
 * would run (`targets`, a sorted JSON array), the graph's hash, the whole
 * review (`snapshot`: the graph, findings and refusals, as JSON, up to
 * 512 KiB, so no list reads it) and the little of it a list shows
 * (`summary`). `source_revision` says which revision of the source the
 * graph was resolved from: provenance, not part of what is approved.
 * `status` moves from `pending` once, in one conditional update, to a
 * person's decision (`approved`, `denied`), which keeps who made it, when,
 * why and under which policy generation. A decided row is never deleted;
 * a pending one is deleted when another proposal for the App takes its
 * place, and its audit event keeps its ID and hash. An approval is this
 * row: another decision on the same graph is another request.
 */
export const dependencyRequests = sqliteTable(
  "dependency_requests",
  {
    id: text().primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    sourceRevision: text("source_revision").notNull(),
    graphHash: text("graph_hash").notNull(),
    targets: text().notNull(),
    purpose: text().notNull(),
    snapshot: text().notNull(),
    summary: text({ mode: "json" }).$type<DependencySummary>().notNull(),
    /** How many packages it asks for directly, and brings in all. */
    direct: integer().notNull(),
    packages: integer().notNull(),
    findings: integer().notNull(),
    refused: integer().notNull(),
    /** The request approved for the App when this one was asked, if any. */
    previous: text(),
    status: text({
      enum: ["pending", "approved", "denied"],
    }).notNull(),
    requestedBy: text("requested_by").notNull(),
    /** The chat's agent that proposed it (JSON); null for a person's own. */
    requestedVia: text("requested_via", {
      mode: "json",
    }).$type<AgentProposer>(),
    requestedAt: timestamp("requested_at").notNull(),
    /** The policy generation it was asked under. */
    policyGeneration: integer("policy_generation").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at"),
    /** The policy generation the decision was made under. */
    decidedGeneration: integer("decided_generation"),
    reason: text(),
  },
  (table) => [
    // One request waits per App: a second pending row is refused.
    uniqueIndex("dependency_requests_pending_idx")
      .on(table.appId)
      .where(sql`status = 'pending'`),
    // The approval an App got last (its status, and what a new request
    // is compared with).
    index("dependency_requests_app_idx").on(
      table.appId,
      table.status,
      table.decidedAt
    ),
    // Whether a graph is approved for an App: a proposal, and admission.
    index("dependency_requests_graph_idx").on(
      table.appId,
      table.graphHash,
      table.status
    ),
  ]
);

/**
 * Whether the deployment is open to the company, in its one row (`id` is
 * `gate`; none yet is open). Grasp's staff close it while the company is
 * onboarding, and open it with their go: until then only the admins named
 * in `SIGN_IN` and staff sign in (src/onboarding/gate.ts). `threshold` is
 * how much of what Grasp needs to know (percent) makes it ready to open.
 */
export const onboardingGate = sqliteTable("onboarding_gate", {
  id: text().primaryKey(),
  closedAt: timestamp("closed_at"),
  threshold: integer().notNull(),
  /** When Grasp's go last opened it: staff with the onboarding scope keep 7 days after. */
  openedAt: timestamp("opened_at"),
  /**
   * When the company's admin last ended Grasp's staff access: a staff
   * window the console opened before then lets nobody in.
   */
  staffEndedAt: timestamp("staff_ended_at"),
});

/**
 * The dependency policy generation, in its one row (`id` is `policy`;
 * none yet counts as 0). It goes up, in the batch that makes the change,
 * each time who holds `dependencies.approve` changes. A decision lands
 * only under the generation its person reviewed, and a build is admitted
 * only under the one it read: what was checked before a change isn't
 * acted on after it.
 */
export const dependencyPolicy = sqliteTable("dependency_policy", {
  id: text().primaryKey(),
  generation: integer().notNull(),
});

/**
 * Who holds `dependencies.approve` (src/dependencies/approvers.ts): a
 * member (`subject_type` `person`, `subject_id` their user ID) or a team.
 * One row per grant, never deleted, so who granted and who revoked stays
 * readable; only its status and the revoke columns ever change. Whether
 * the member or team is still there is read from the organization's own
 * tables each time.
 */
export const dependencyApprovers = sqliteTable(
  "dependency_approvers",
  {
    id: text().primaryKey(),
    subjectType: text("subject_type", { enum: ["person", "team"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    status: text({ enum: ["active", "revoked"] }).notNull(),
    grantedBy: text("granted_by").notNull(),
    grantedAt: timestamp("granted_at").notNull(),
    revokedBy: text("revoked_by"),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [
    // A member or team holds it once: a second live grant is refused.
    uniqueIndex("dependency_approvers_live_idx")
      .on(table.subjectType, table.subjectId)
      .where(sql`status = 'active'`),
  ]
);

/**
 * The exact lock (`grasp.lock.json`) the resolver produced for one of an
 * App's dependency graphs (src/packages/resolve.ts), by the graph's hash:
 * what a build of an approved graph unpacks, by integrity, and with which
 * export conditions per target. One per App and graph. Its packages never
 * change (the graph's hash covers them; the first lock's ranges and times
 * stay its provenance); a later resolve of the same graph sets the
 * targets it asks for (`mergedLock`), each write conditional on the lock
 * as it was read. At most `packageLimits.lockBytes`.
 */
export const dependencyLocks = sqliteTable(
  "dependency_locks",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    graphHash: text("graph_hash").notNull(),
    lock: text().notNull(),
    createdAt: timestamp("created_at").notNull(),
    /**
     * Until when an address of one of its artifacts handed out holds
     * (src/packages/address.ts): until then the lock never gives up its
     * room to a new one (src/packages/locks.ts), so what was handed out
     * keeps being served. Null when none was.
     */
    servedUntil: timestamp("served_until"),
  },
  (table) => [primaryKey({ columns: [table.appId, table.graphHash] })]
);

/**
 * Files of the deployment's package store that may no longer be needed,
 * recorded before they could be left behind (src/packages/cleanup.ts): a
 * tarball (`kind` `tarball`, `key` its integrity) as it is stored, and the
 * tarballs and pinned artifacts of a lock as it is deleted; an artifact
 * (`kind` `build`, `key` its hash) as a build writes its files. The cron
 * deletes the files of one no lock names once it is an hour old, then the
 * row; one a lock names loses its row only. Recording one again moves its
 * time on.
 */
export const packageCleanups = sqliteTable(
  "package_cleanups",
  {
    key: text().primaryKey(),
    kind: text({ enum: ["tarball", "build"] }).notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    // The cron's sweep: records an hour old, oldest first.
    index("package_cleanups_created_at_idx").on(table.createdAt),
  ]
);

/**
 * The one build under way of each target of an App's graph
 * (src/packages/build.ts): a build takes its lease before it builds, and
 * gives it back when it ends; another of the same App, graph and target
 * waits for it, then hands out what it pinned. A lease that outlived
 * `expiresAt` (a build that died) may be taken, and the cron deletes it
 * once nobody did (src/packages/cleanup.ts).
 */
export const dependencyBuildLeases = sqliteTable(
  "dependency_build_leases",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    graphHash: text("graph_hash").notNull(),
    target: text().notNull(),
    holder: text().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.appId, table.graphHash, table.target] }),
    // The cron's sweep of leases that lapsed.
    index("dependency_build_leases_expires_at_idx").on(table.expiresAt),
  ]
);

/**
 * Each refused admission the audit trail recorded, once per App, graph,
 * set of targets, policy generation in force and reason
 * (src/dependencies/requests.ts):
 * a build asking again and again for the same refused graph adds no more
 * audit rows. Only for a graph some request of the App's names; a refusal
 * of any other hash is logged, never stored.
 */
export const dependencyAdmissionRefusals = sqliteTable(
  "dependency_admission_refusals",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    graphHash: text("graph_hash").notNull(),
    targets: text().notNull(),
    policyGeneration: integer("policy_generation").notNull(),
    reason: text().notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.appId,
        table.graphHash,
        table.targets,
        table.policyGeneration,
        table.reason,
      ],
    }),
  ]
);

/**
 * The values people set for workflows' parameters, one per App, workflow
 * and parameter; a parameter without one has its code's default. `set_by`
 * set it directly.
 */
export const workflowParamValues = sqliteTable(
  "workflow_param_values",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    workflowId: text("workflow_id").notNull(),
    param: text().notNull(),
    value: text({ mode: "json" }).$type<ParamValue>().notNull(),
    setBy: text("set_by").notNull(),
    setAt: timestamp("set_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.appId, table.workflowId, table.param] }),
  ]
);

/**
 * The catalog entries an admin stopped offering (connections.ts): one row
 * each, by its source (`native` or `composio`) and its ID there. Nobody
 * starts connecting a hidden entry, admins included, until an admin offers
 * it again, which deletes its row. Everything else is offered, a new
 * Composio toolkit too. Connections made before an entry was hidden go on.
 */
export const hiddenConnectors = sqliteTable(
  "hidden_connectors",
  {
    source: text({ enum: ["native", "composio"] }).notNull(),
    connectorId: text("connector_id").notNull(),
    hiddenBy: text("hidden_by").notNull(),
    hiddenAt: timestamp("hidden_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.source, table.connectorId] })]
);

/**
 * Each computation of the improvement signals (src/signals.ts), one a UTC
 * day: `started_at` claims it, `finished_at` is set once all its signals
 * are written. The signals people read are those of the finished one
 * started last; finishing deletes every computation started before it,
 * with its signals.
 */
export const improvementSignalComputations = sqliteTable(
  "improvement_signal_computations",
  {
    id: text().primaryKey(),
    /** The UTC day it is the computation of, such as `2026-09-27`. */
    day: text().notNull(),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    index("improvement_signal_computations_day_idx").on(table.day),
    index("improvement_signal_computations_started_idx").on(table.startedAt),
  ]
);

/**
 * The improvement signals of a computation: one per kind, App, workflow
 * and subject (the deciders, the step, a search's key). `app_id` and
 * `workflow_id` are empty for the deployment's own signals and for none.
 * `value` ranks it within its kind; `evidence` is JSON, IDs and counts
 * only (@grasp-os/shared/signals).
 */
export const improvementSignals = sqliteTable(
  "improvement_signals",
  {
    computation: text()
      .notNull()
      .references(() => improvementSignalComputations.id),
    appId: text("app_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    kind: text({ enum: signalKinds }).notNull(),
    subject: text().notNull(),
    value: real().notNull(),
    evidence: text({ mode: "json" }).$type<Json>().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.computation,
        table.appId,
        table.workflowId,
        table.kind,
        table.subject,
      ],
    }),
    index("improvement_signals_kind_idx").on(
      table.computation,
      table.kind,
      table.value
    ),
  ]
);

/**
 * The statistics Apps record (src/statistics.ts), added up by the UTC day:
 * one row per App, measure, day and dimensions (canonical JSON), holding
 * how many points, their sum, lowest and highest. So a read over a year
 * reads at most a day's rows (`statisticRowsPerDay`) for each day, and a
 * point is one upsert. Rows past the retention (`statisticRetentionDays`)
 * are swept.
 */
export const appStatistics = sqliteTable(
  "app_statistics",
  {
    appId: text("app_id").notNull(),
    measure: text().notNull(),
    /** `YYYY-MM-DD`, UTC. */
    day: text().notNull(),
    /** Canonical JSON of the point's dimensions, `{}` for none. */
    dimensions: text().notNull(),
    count: integer().notNull(),
    sum: real().notNull(),
    min: real().notNull(),
    max: real().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.appId, table.measure, table.day, table.dimensions],
    }),
    // A day's rows of an App, counted against its daily bound.
    index("app_statistics_app_day_idx").on(table.appId, table.day),
    // The sweep of rows past the retention.
    index("app_statistics_day_idx").on(table.day),
  ]
);

/**
 * The statistics points the attempts of a workflow run's steps recorded
 * through Apps' methods, not yet added up (src/statistics.ts): one row
 * per step (its idempotency key), attempt, App, measure, day and
 * dimensions, holding what `app_statistics` holds of them. When a step
 * that called an App completes, the points of the attempt that completed
 * it are added to `app_statistics`, and the step gets its marker (a row
 * of no App and no measure, `committed`), in one batch; no other
 * attempt's ever are, and a step with its marker adds nothing again.
 * Kept only while the run hasn't ended, and deleted when it ends.
 */
export const appStatisticSteps = sqliteTable(
  "app_statistic_steps",
  {
    /** The step's idempotency key (`stepIdempotencyKey`): its run's ID first. */
    stepKey: text("step_key").notNull(),
    /** The attempt of the step, an ID the run's engine gives each. */
    attempt: text().notNull(),
    appId: text("app_id").notNull(),
    measure: text().notNull(),
    /** `YYYY-MM-DD`, UTC. */
    day: text().notNull(),
    /** Canonical JSON of the point's dimensions, `{}` for none. */
    dimensions: text().notNull(),
    count: integer().notNull(),
    sum: real().notNull(),
    min: real().notNull(),
    max: real().notNull(),
    /** Set on the step's marker only: the step completed with this attempt. */
    committed: integer({ mode: "boolean" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.stepKey,
        table.attempt,
        table.appId,
        table.measure,
        table.day,
        table.dimensions,
      ],
    }),
  ]
);

/**
 * Every version of core the cron has seen running (src/platform-updates.ts),
 * each recorded once: the insert of a version not here is audited as
 * `platform.updated` in the same batch.
 */
export const platformVersions = sqliteTable("platform_versions", {
  versionId: text("version_id").primaryKey(),
  recordedAt: timestamp("recorded_at").notNull(),
});

/**
 * What core tells a person in the product (src/notifications.ts): for
 * now, that a workflow failed while acting for them (`run_failed`). One
 * unread row per person, App and workflow: another failure while it is
 * unread counts on it (`failures`) and names the latest run (`run_id`), so
 * a workflow that fails every minute makes one row, not thousands. Once
 * read (`read_at`), the next failure makes a new one. The person's rows
 * read over 30 days ago go when they next read, and all of them when
 * they are removed from the organization.
 */
export const notifications = sqliteTable(
  "notifications",
  {
    id: text().primaryKey(),
    personId: text("person_id").notNull(),
    type: text({ enum: ["run_failed"] }).notNull(),
    appId: text("app_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    runId: text("run_id").notNull(),
    failures: integer().notNull(),
    createdAt: timestamp("created_at").notNull(),
    /** When it last changed: the latest failure it counts. */
    updatedAt: timestamp("updated_at").notNull(),
    readAt: timestamp("read_at"),
  },
  (table) => [
    // A person's list, latest first.
    index("notifications_person_idx").on(
      table.personId,
      table.updatedAt,
      table.id
    ),
    // The one unread row a failure counts on, and the unread count.
    uniqueIndex("notifications_unread_idx")
      .on(table.personId, table.type, table.appId, table.workflowId)
      .where(sql`read_at IS NULL`),
  ]
);

/**
 * A guest chat (src/guests.ts): someone who isn't a member, invited by an
 * App for one of its people, chatting with a model through a link. The
 * link's secret is never stored, only its SHA-256 (`token_hash`). A chat
 * takes one turn at a time: `busy_until` is set while one is under way,
 * and a turn claims it only when it is unset or past.
 */
export const guestChats = sqliteTable(
  "guest_chats",
  {
    id: text().primaryKey(),
    appId: text("app_id").notNull(),
    /** The permission it was made under: each turn needs it still active. */
    permissionId: text("permission_id").notNull(),
    /** The member it was made for: its turns spend their model budget. */
    invitedBy: text("invited_by").notNull(),
    name: text().notNull(),
    skill: text().notNull(),
    /** The model it talks with, the deployment's first when invited. */
    model: text().notNull(),
    tokenHash: text("token_hash").notNull(),
    turns: integer().notNull(),
    busyUntil: timestamp("busy_until"),
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    /** When the guest first opened it. */
    openedAt: timestamp("opened_at"),
    /** When the guest finished it, or it was revoked. */
    endedAt: timestamp("ended_at"),
    ended: text({ enum: ["finished", "revoked"] }),
  },
  (table) => [
    uniqueIndex("guest_chats_token_idx").on(table.tokenHash),
    // An App's chats, newest first.
    index("guest_chats_app_idx").on(table.appId, table.createdAt, table.id),
    // An App's chats that haven't ended, newest first: listed first, and
    // counted as it invites. Expired ones stay in it until they are swept.
    index("guest_chats_open_idx")
      .on(table.appId, table.createdAt, table.id)
      .where(sql`ended IS NULL`),
    // What the retention sweep deletes, oldest first.
    index("guest_chats_expires_idx").on(table.expiresAt),
  ]
);

/** A guest chat's messages, in order: the guest's, and the model's answers. */
export const guestMessages = sqliteTable(
  "guest_messages",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => guestChats.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    role: text({ enum: ["guest", "agent"] }).notNull(),
    text: text().notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.seq] })]
);

/**
 * The deployment's business stores (src/data-stores.ts): an inventory,
 * never a copy of their records. Each store's records, receipts and
 * outbox live in its own Durable Object (src/data-store.ts), named by
 * this ID, which the host mints and which no App, workflow or run ID
 * becomes. `physical_namespace_role` says which namespace of objects
 * holds it. The active schema and operation hashes are filled in once a
 * store activates a schema; until then they are null. A deleted store
 * keeps its row, with `deleted_at` set, and is never served again.
 */
export const businessStores = sqliteTable("business_stores", {
  id: text().primaryKey(),
  /** The user who created it. */
  ownerId: text("owner_id").notNull(),
  activeSchemaVersion: integer("active_schema_version"),
  activeSchemaHash: text("active_schema_hash"),
  activeOperationManifestHash: text("active_operation_manifest_hash"),
  /** Moves on with every change of who may use the store. */
  policyGeneration: integer("policy_generation").notNull().default(1),
  physicalNamespaceRole: text("physical_namespace_role", {
    enum: ["data_store"],
  }).notNull(),
  createdAt: timestamp("created_at").notNull(),
  deletedAt: timestamp("deleted_at"),
});
