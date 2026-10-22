import type { AgentProposer, AppExports } from "@grasp-os/shared/apps";
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
  check,
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

/**
 * Better Auth's JWT plugin's signing keys: the key pairs App tokens are
 * signed with (auth/app-tokens.ts), each private key encrypted with the
 * auth secret. A key is replaced once it expires; the tokens it signed
 * still verify while its row is kept.
 */
export const jwks = sqliteTable("jwks", {
  id: text().primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at").notNull(),
  expiresAt: timestamp("expires_at"),
  alg: text(),
  crv: text(),
});

/** The deployment's one organization. */
export const organizations = sqliteTable("organizations", {
  id: text().primaryKey(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  logo: text(),
  metadata: text(),
  createdAt: timestamp("created_at").notNull(),
  /** The IANA time zone an admin set (organization.ts); `UTC` until then. */
  timeZone: text("time_zone"),
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
 * What each App, agent, independent workflow, business store and trigger
 * may use: one row per permission, never deleted, so who asked, who
 * granted and who revoked stays readable. Only its status and the grant
 * and revoke columns ever change.
 *
 * The object is stored by type: a connection is `object_id`, with
 * `resource` naming one resource in it or null for all of it; a collection
 * is `object_id`; a workflow is its workflow resource's ID in `object_id`;
 * another App's exports are that App's ID in `object_id`. `actions` is a
 * JSON array of action names.
 */
export const permissions = sqliteTable(
  "permissions",
  {
    id: text().primaryKey(),
    subjectType: text("subject_type", {
      enum: ["app", "agent", "workflow", "store", "trigger"],
    }).notNull(),
    subjectId: text("subject_id").notNull(),
    objectType: text("object_type", {
      enum: [
        "connection",
        "collection",
        "workflow",
        "app",
        "store",
        "platform",
      ],
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
    // Revocations of a subject's permissions since a moment: what ends a
    // chat's code runs (`revokedSince` in agent-scope.ts).
    index("permissions_revoked_idx").on(
      table.subjectType,
      table.subjectId,
      table.status,
      table.revokedAt
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
 * Revocations an App's host couldn't be told of (src/access-revocations.ts):
 * told again by the cron trigger until it takes them, so a host away for
 * longer than its retries still clears the screens of whoever lost a
 * role. `user_ids` is null for everyone the host knows of.
 */
export const accessRevocations = sqliteTable(
  "access_revocations",
  {
    id: text().primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    userIds: text("user_ids", { mode: "json" }).$type<string[] | null>(),
    attempts: integer().notNull().default(0),
    createdAt: timestamp("created_at").notNull(),
  },
  // The cron trigger tells the least tried first, oldest first among them,
  // once it dropped those a day old.
  (table) => [
    index("access_revocations_due").on(table.attempts, table.createdAt),
    index("access_revocations_age").on(table.createdAt),
  ]
);

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
     * The binding names the App's permissions held when the version was
     * committed, whatever their status, each with the kind of binding it
     * is (JSON, `WorkflowBindingKinds`, permissions.ts): what its
     * workflows' `env` is typed by at every build, so a version is typed
     * the same however its App's permissions change after. A row the
     * previous release writes gets none (the default).
     */
    workflowBindings: text("workflow_bindings", { mode: "json" })
      .$type<Record<string, "connection" | "collection">>()
      .notNull()
      .default(sql`'{}'`),
  },
  (table) => [primaryKey({ columns: [table.appId, table.version] })]
);

/**
 * The sealed release of an App version of spec 8's layout (spec 16;
 * src/app-releases.ts): its manifest's canonical text, which pins the
 * version's source tree, schema, contracts, runtime and artifacts, and the
 * SHA-256 of that text. Written once, by the seal, and never changed: a
 * seal of the same version with another manifest is refused. Its trust
 * isn't here: the manifest always says `unreviewed`.
 */
export const sdkReleaseManifests = sqliteTable(
  "sdk_release_manifests",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    version: integer().notNull(),
    manifestHash: text("manifest_hash").notNull(),
    manifest: text().notNull(),
    sealedAt: timestamp("sealed_at").notNull(),
    /**
     * When the retention sweep last saw the version current or pending
     * (src/release-retention.ts): it is kept at least 90 days after that.
     * Null for one never seen so; its seal starts its retention then.
     */
    lastCurrentAt: timestamp("last_current_at"),
    /**
     * When the sweep first found nothing that keeps it: deleted once that
     * has held for a day and still holds. Null while something keeps it.
     */
    unreferencedSince: timestamp("unreferenced_since"),
    /**
     * When an admin revoked it: it runs no more (`version.revoked`), but
     * its bytes stay for audit and recovery, under the same retention.
     */
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [primaryKey({ columns: [table.appId, table.version] })]
);

/**
 * Which sealed releases name which artifact, by its SHA-256 (src/app-
 * releases.ts, src/release-retention.ts): a seal reserves its artifacts
 * here before it stores their bytes, and an artifact's bytes are deleted
 * only once no row names it, under a deletion mark
 * (`sdk_artifact_deletions`) a seal can't reserve past. A reservation of
 * a seal that never finished is swept with its release's grace. `app_id`
 * is the release's resource: an App, or an independent workflow whose
 * version's build is sealed (src/workflow-builds.ts), whose reservations
 * stay as long as its version, for good.
 */
export const sdkReleaseArtifacts = sqliteTable(
  "sdk_release_artifacts",
  {
    sha256: text().notNull(),
    appId: text("app_id").notNull(),
    version: integer().notNull(),
    reservedAt: timestamp("reserved_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sha256, table.appId, table.version] }),
    index("sdk_release_artifacts_release").on(table.appId, table.version),
  ]
);

/**
 * An artifact's bytes being deleted: marked when no release named it, so
 * no seal reserves it again until the bytes are gone and the mark is
 * removed. Only its owner finishes a mark, before its deadline (15
 * minutes after it was placed), and removes it only once the bytes are
 * deleted; a mark an hour old is taken over by whoever finds it
 * (src/release-retention.ts).
 */
export const sdkArtifactDeletions = sqliteTable("sdk_artifact_deletions", {
  sha256: text().primaryKey(),
  owner: text().notNull(),
  startedAt: timestamp("started_at").notNull(),
});

/**
 * Bytes whose last reservation went: queued in the statement that removes
 * the reservation, and dequeued only once the bytes are dealt with
 * (deleted, reserved again, or another deleter's), so no bytes are ever
 * left without a reservation or a queue entry (src/release-retention.ts).
 */
export const sdkArtifactCandidates = sqliteTable("sdk_artifact_candidates", {
  sha256: text().primaryKey(),
  queuedAt: timestamp("queued_at").notNull(),
});

/**
 * The manifest hash of each sealed release the retention sweep deleted:
 * sealing that App version again must make the same manifest, so a
 * version's number never comes to name other code.
 */
export const sdkReleaseTombstones = sqliteTable(
  "sdk_release_tombstones",
  {
    appId: text("app_id").notNull(),
    version: integer().notNull(),
    manifestHash: text("manifest_hash").notNull(),
    deletedAt: timestamp("deleted_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.appId, table.version] })]
);

/**
 * What keeps a sealed release past its retention (spec 16.3): an open
 * screen's lease, which lapses 15 minutes after its last renewal, or a
 * run, a compatible migration, a pinned trigger or a legal hold, held
 * until released.
 */
export const sdkReleasePins = sqliteTable(
  "sdk_release_pins",
  {
    appId: text("app_id").notNull(),
    version: integer().notNull(),
    holderKind: text("holder_kind", {
      enum: ["frame", "run", "migration", "trigger", "hold"],
    }).notNull(),
    holderId: text("holder_id").notNull(),
    /** When it lapses, for a frame's lease; null for a held pin. */
    expiresAt: timestamp("expires_at"),
    pinnedAt: timestamp("pinned_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.appId, table.version, table.holderKind, table.holderId],
    }),
  ]
);

/**
 * What a sealed release binds, by alias (spec 16.1): the store it reads and
 * writes, which only the host chose when it sealed the release, or, for a
 * workflow version (`resource_id` a workflow resource's), the exact version
 * of another workflow it runs (`kind` `workflow`, `schema_hash` that
 * version's contract hash, workflow-resources.ts).
 * Routing, not a grant: whoever calls is authorized on every call. Also
 * how a store finds the releases that still rely on it: it can't be
 * deleted while any release kept is bound to it (data-stores.ts), and
 * retention deletes a release's rows here with it.
 */
export const sdkResourceBindings = sqliteTable(
  "sdk_resource_bindings",
  {
    resourceId: text("resource_id").notNull(),
    resourceVersion: integer("resource_version").notNull(),
    alias: text().notNull(),
    kind: text({
      enum: [
        "store",
        "workflow",
        "operation",
        "connector",
        "model",
        "decision",
        "event",
        "knowledge",
        "template",
        "files",
      ],
    }).notNull(),
    targetId: text("target_id").notNull(),
    schemaHash: text("schema_hash").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    /**
     * The target's version: for a store, the definition this release
     * binds (`business_store_versions.version`).
     */
    targetVersion: integer("target_version"),
    /**
     * The contract key the binding's source named, as the host resolved
     * it (a workflow's `namespace/name/semver`); null for a store's.
     */
    contractId: text("contract_id"),
  },
  (table) => [
    primaryKey({
      columns: [table.resourceId, table.resourceVersion, table.alias],
    }),
    index("sdk_resource_bindings_target").on(table.kind, table.targetId),
  ]
);

/**
 * The definitions a business store serves, in core's inventory (spec 24):
 * each distinct schema and operation manifest a sealed release bound the
 * store with, numbered per store as it first appears, with the source
 * tree of the release that first bound it. Written in the seal's batch
 * (app-releases.ts), never changed. The store's object holds the schemas
 * themselves, its receipts and its outbox, and stays their authority.
 */
export const businessStoreVersions = sqliteTable(
  "business_store_versions",
  {
    storeId: text("store_id").notNull(),
    version: integer().notNull(),
    schemaHash: text("schema_hash").notNull(),
    operationManifestHash: text("operation_manifest_hash").notNull(),
    sourceTreeHash: text("source_tree_hash").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.version] }),
    uniqueIndex("business_store_versions_definition").on(
      table.storeId,
      table.schemaHash,
      table.operationManifestHash
    ),
  ]
);

/**
 * The App a store serves, claimed by the first seal that binds it and kept
 * for good: retention deletes releases and their bindings, never this. So
 * a store an App stopped using never comes to serve another App, which
 * would read what the first left behind.
 */
export const sdkStoreOwners = sqliteTable("sdk_store_owners", {
  storeId: text("store_id").primaryKey(),
  appId: text("app_id").notNull(),
  claimedAt: timestamp("claimed_at").notNull(),
});

/**
 * The store an App of spec 8's layout runs on, one per App: created by the
 * host when it first seals a version of the App whose schema has tables
 * (app-activation.ts), and bound to every later version, so the App's data
 * outlives its versions. Never chosen by a request.
 */
export const appDefaultStores = sqliteTable("app_default_stores", {
  appId: text("app_id").primaryKey(),
  storeId: text("store_id").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
});

/**
 * The fixture stores an App's tests run on (app-tests.ts), each recorded
 * before its object is first touched and deleted once the object is
 * discarded: a row left behind is a test run that died between the two,
 * whose store the sweep discards. A fixture store is never in the store
 * inventory (`business_stores`), so nothing opens or binds it as a store.
 */
export const appTestFixtures = sqliteTable(
  "app_test_fixtures",
  {
    storeId: text("store_id").primaryKey(),
    appId: text("app_id").notNull(),
    version: integer().notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [index("app_test_fixtures_created_at").on(table.createdAt)]
);

/**
 * The recovery index of screens' keyed submissions (spec 10.7.8,
 * screen-submissions.ts): one row per mutation or action a person's screen
 * sent under an idempotency key, written as core admits it and deleted
 * once the person's screen got an answer its receipt settled. A row left
 * is one whose answer may never have reached them: the shell reads its status from the
 * receipt its key names, never anything it changed or answered. Only the
 * descriptor and the key: no input, no result. A row goes with its
 * receipt's retention (`expires_at`), and a person keeps at most
 * `maxSubmissionsPerApp` of an App and `maxSubmissionsPerPerson` in all.
 */
export const screenSubmissions = sqliteTable(
  "screen_submissions",
  {
    id: text().primaryKey(),
    personId: text("person_id").notNull(),
    appId: text("app_id").notNull(),
    kind: text({ enum: ["mutation", "action"] }).notNull(),
    /** The function's contract ID, as the screen's reference names it. */
    contractId: text("contract_id").notNull(),
    fingerprint: text().notNull(),
    /** The App version whose release resolved the call. */
    appVersion: integer("app_version").notNull(),
    /** The function's path in that release, for its receipt's scope. */
    path: text().notNull(),
    /**
     * For a mutation, the store its receipt is in and the contract ID that
     * scopes it (operations.ts `operationContractId`), as the release that
     * ran it had them: null for an action, and for a release with no store.
     */
    storeId: text("store_id"),
    storeContractId: text("store_contract_id"),
    /**
     * For a mutation core answered as run and failed (its handler's own
     * failure, which commits nothing and leaves its receipt claimed), that
     * failure's category: it reads as `failed` unless a later attempt
     * under its key committed.
     */
    failedCategory: text("failed_category"),
    /**
     * The receipt fence the failed attempt itself claimed: a newer claim
     * since is another attempt, which may still commit.
     */
    failedFence: integer("failed_fence"),
    /**
     * Which attempt under its key the row follows, from 1: each one noted
     * moves it on, and core's answer marks the row only for its own.
     */
    attempt: integer().notNull().default(1),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    uniqueIndex("screen_submissions_key").on(
      table.personId,
      table.appId,
      table.kind,
      table.contractId,
      table.fingerprint,
      table.idempotencyKey
    ),
    index("screen_submissions_person").on(table.personId, table.createdAt),
    index("screen_submissions_expires_at").on(table.expiresAt),
    index("screen_submissions_app").on(table.personId, table.appId),
    check(
      "screen_submissions_kind",
      sql`${table.kind} IN ('mutation', 'action')`
    ),
  ]
);

/**
 * The fixture stores chats' previews of their drafts run on
 * (sealed-previews.ts), each recorded before its object is first touched
 * and deleted once the object is discarded. Kept apart from App tests'
 * (`app_test_fixtures`), whose sweep discards a store an hour after it
 * was made: a preview's lives as long as its draft's revision, and the
 * chat's Workspace object, which also records it, discards it then; core
 * discards it a week after it was made whatever that object does
 * (`sweepPreviewStores`, by `created_at`). A fixture store is never in the
 * store inventory (`business_stores`).
 */
export const previewFixtureStores = sqliteTable(
  "preview_fixture_stores",
  {
    storeId: text("store_id").primaryKey(),
    appId: text("app_id").notNull(),
    createdAt: timestamp("created_at").notNull(),
    /**
     * When the sweep tries it again, once a discard of it failed or ran out
     * of time: until then it steps past it, so a store that keeps failing
     * never holds up the rest. Null until one did.
     */
    retryAfter: timestamp("retry_after"),
  },
  (table) => [index("preview_fixture_stores_created_at").on(table.createdAt)]
);

/**
 * Published templates (resource-bindings.ts): each version's content,
 * written once by an admin and never changed, so a binding to a version
 * always reads exactly what was approved (spec 32.3). A template keeps the
 * contract of its first version; a new version is a new row.
 */
export const resourceTemplates = sqliteTable(
  "resource_templates",
  {
    id: text().notNull(),
    version: integer().notNull(),
    contract: text().notNull(),
    /** The content, as canonical JSON. */
    content: text().notNull(),
    /** The SHA-256 of `content`. */
    contentHash: text("content_hash").notNull(),
    publishedBy: text("published_by").notNull(),
    publishedAt: timestamp("published_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.id, table.version] })]
);

/**
 * Which provider serves each resource an App of spec 8's layout declares
 * for its actions (resource-bindings.ts): approved by an admin, for the
 * exact declaration they reviewed (`declaration_hash`) and the contract it
 * serves as it was then (`contract_id`, `fingerprint`). `target` is the
 * provider (JSON, `BindingTarget`): a model, one of the App's permissions
 * or a template version. At most one active binding per alias; approving
 * another revokes it in the same batch. Revoked rows stay, for the audit
 * log's references.
 */
export const appResourceBindings = sqliteTable(
  "app_resource_bindings",
  {
    id: text().primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    alias: text().notNull(),
    kind: text({
      enum: [
        "model",
        "connector",
        "knowledge",
        "template",
        "store",
        "statistics",
        "guests",
        "app",
      ],
    }).notNull(),
    target: text().notNull(),
    declarationHash: text("declaration_hash").notNull(),
    contractId: text("contract_id").notNull(),
    fingerprint: text().notNull(),
    reviewedVersion: integer("reviewed_version").notNull(),
    status: text({ enum: ["active", "revoked"] }).notNull(),
    approvedBy: text("approved_by").notNull(),
    approvedAt: timestamp("approved_at").notNull(),
    revokedBy: text("revoked_by"),
    revokedAt: timestamp("revoked_at"),
    /**
     * A model binding's own caps, as JSON (`modelBindingBudgetSchema`):
     * set at approval, null for none (model-budgets.ts).
     */
    budget: text(),
  },
  (table) => [
    uniqueIndex("app_resource_bindings_active_idx")
      .on(table.appId, table.alias)
      .where(sql`${table.status} = 'active'`),
  ]
);

/**
 * Every run of an App's workflow (src/workflows/): the App version it is
 * pinned to, and who it acts for. A run a person started acts for them
 * (`started_by`); one a trigger started (`started_by` null) for the App's
 * owner. The engine keeps the run's steps (src/workflows/engine.ts); this row is what core
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
    /**
     * The run its lineage started from, for a run another run started
     * (src/workflows/runs.ts, `startRun`'s `parent`): the parent's own
     * root, so every descendant names the same one. Null for a run that
     * is its own root. Written once, with the row, and never from what the
     * run is given: the model gateway counts the lineage's model calls and
     * spend by it, unless the run is charged to an account
     * (`accountRunId`, src/model-budgets.ts).
     */
    rootRunId: text("root_run_id"),
    /**
     * For a run of another App than its lineage root's (a run's own mail
     * starts other Apps' runs under it, src/workflows/connector-events.ts),
     * or of the root's App under another App's run: the run whose
     * allowances its work is charged to, the first run of its kind in the
     * lineage (`run_lineage_accounts`). Its attempts, host
     * calls, model spend and share count there; its place (descendants,
     * depth, age) stays the lineage's. A run of the root's App whose parent
     * is of that App too takes its parent's: so under a run of the root's
     * App charged to an account (one under another App's run), it is
     * charged there as well. Null for a root, and for a run of the root's
     * App whose parent, of that App, is charged to the lineage's own
     * (src/workflows/quotas.ts, `accountClaimed`). Written once, with the
     * row: never changed once set (migration 0112's trigger).
     */
    accountRunId: text("account_run_id"),
    /**
     * The sequence of the engine's latest status notification this row
     * took (src/workflows/projection.ts): one at or below it is late, and
     * changes nothing. The engine alone decides a run's status; this row
     * follows it.
     */
    engineSequence: integer("engine_sequence").notNull().default(0),
    /**
     * The start the engine is still to confirm, as it is sent (`{ input }`,
     * src/workflows/engine.ts): kept until the engine's first notification
     * of the run, so a start core stopped in the middle of is sent again,
     * the same, by the repair (src/workflows/runs.ts, `repairStarts`).
     * Null once confirmed, and for a run whose start failed.
     */
    pendingStart: text("pending_start", { mode: "json" }).$type<{
      input?: Json;
    }>(),
    /**
     * When someone cancelled the run: its tombstone. From then on the
     * dispatcher runs nothing more of it, whatever the engine still does,
     * and the engine is told to terminate it; its status turns `cancelled`
     * once the engine has.
     */
    cancelRequestedAt: timestamp("cancel_requested_at"),
    /**
     * The generation of the run's controls (src/workflows/controls.ts):
     * one more with each pause or resume admitted, and with a cancel,
     * which supersedes them. A control applies to the engine only while
     * its own generation is the run's, so a late one can't undo a newer.
     */
    controlGeneration: integer("control_generation").notNull().default(0),
    /**
     * Where the engine last said the run is (its own status, a phase
     * `status` folds away: waiting, rolling back), as the projection took
     * it (src/workflows/runs.ts). Null until the engine's first notification.
     */
    engineStatus: text("engine_status"),
    /**
     * Why the engine rolls the run back, as it began to (src/workflows/
     * runs.ts): a JSON object of its cause (`failure` or `cancellation`)
     * and, for a failure, its code. What its summary's compensation says
     * (spec 10.7.3).
     */
    compensation: text(),
    /** When the engine first ran the run; null until it has. */
    startedAt: timestamp("started_at"),
    /**
     * The revision of the run's summary (src/workflows/summary.ts): one
     * more with every write that changes what it shows, in that write's own
     * transaction, so a summary read in one statement is of one revision.
     */
    summaryRevision: integer("summary_revision").notNull().default(0),
    /**
     * How deep in its lineage the run is: 0 for a root, its parent's depth
     * and one more for a run another started (src/workflows/quotas.ts).
     * Written once, with the row, from the parent's row, never from what
     * the run is given: a lineage nests no deeper than the quota policy
     * allows however its runs start one another.
     */
    depth: integer().notNull().default(0),
    /**
     * The newest activation generation of the run whose attempts the
     * engine has fenced, as its object last said (src/workflows/quotas.ts,
     * `sharesReleased`): their shares of the attempts running at once were
     * given back, and an attempt of this generation, or an older one, takes
     * none again, however late its admission lands. Only grows.
     */
    sharesFencedThrough: integer("shares_fenced_through").notNull().default(0),
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
    // The start repair (src/workflows/runs.ts, `repairStarts`): starts the
    // engine is still to confirm, by ID, which the repair pages by.
    index("workflow_runs_pending_start_idx")
      .on(table.id)
      .where(sql`pending_start IS NOT NULL`),
    // The improvement signals (src/signals.ts): runs that failed in a
    // window, latest first. Runs started in one are counted per App
    // workflow by the index above.
    index("workflow_runs_status_ended_idx").on(
      table.status,
      table.endedAt,
      table.id
    ),
    uniqueIndex("workflow_runs_trigger_key_idx").on(table.triggerKey),
    // A lineage's runs by its root, for the model ledger to learn whether
    // every run of it has ended (src/run-lineage-ends.ts). Only runs
    // another run started have one.
    index("workflow_runs_root_idx")
      .on(table.rootRunId)
      .where(sql`root_run_id IS NOT NULL`),
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
 * Each run lineage's durable counters (src/workflows/quotas.ts): a root
 * run and every run started under it, at any depth, keyed by the root.
 * Created with the root's row, or with the lineage's first admission
 * after it, from the root's row. Every admission of the lineage's work
 * checks these against the quota policy as it is then, in one statement
 * that changes them only if the work fits, so admissions racing each
 * other never pass a limit, and nothing a retry, a restart, a child or a
 * branch does starts them afresh: they only grow (but for `active_held_ms`,
 * which moves into `active_used_ms` as attempts settle, and `host_calls`,
 * of which an attempt gives back what it reserved and didn't make).
 *
 * - `created_at`: the root's start, which the lineage's age counts from.
 *   A wait doesn't move it, nor does a child.
 * - `descendants`: runs admitted under the root, whether or not their
 *   start then succeeded: a slot taken is never given back.
 * - `active_used_ms`: wall time its steps' attempts used, settled.
 * - `active_held_ms`: what attempts under way hold, each its whole
 *   allowance until it settles (`run_lineage_attempts`).
 * - `policy_generation`: the quota policy's generation at the latest
 *   admission.
 * - `host_calls`: host calls its attempts reserved, in blocks; once an
 *   attempt settles, only those it made.
 */
export const runLineages = sqliteTable("run_lineages", {
  /**
   * The root run's ID: an App's run (`workflow_runs`) or an independent
   * workflow's (`workflow_resource_runs`). No foreign key can name both,
   * so a trigger refuses a root neither has (migration 0093).
   */
  rootRunId: text("root_run_id").primaryKey(),
  createdAt: timestamp("created_at").notNull(),
  descendants: integer().notNull().default(0),
  activeUsedMs: integer("active_used_ms").notNull().default(0),
  activeHeldMs: integer("active_held_ms").notNull().default(0),
  policyGeneration: integer("policy_generation").notNull().default(0),
  hostCalls: integer("host_calls").notNull().default(0),
});

/**
 * The reservation receipt of each step attempt a run lineage admitted
 * (src/workflows/quotas.ts): one per attempt, as the engine names it (its
 * run, its step's key, its number and the generation of the activation
 * that claimed it), so the same attempt admitted twice holds once, and an
 * attempt of another activation is admitted afresh: it runs again. It
 * holds `reserved_ms` (its allowance up to its deadline, at most an
 * attempt's default active wall time) until it settles with what it used
 * (`used_ms`, `settled_at`), up to its `deadline`; one that never settles
 * (its activation died) is settled as having used what it ran once the
 * engine fenced it (its run paused, ended or cancelled, its activation
 * taken over), or all it could, once its deadline has passed.
 */
export const runLineageAttempts = sqliteTable(
  "run_lineage_attempts",
  {
    /**
     * The attempt's run, of either table, as `run_lineages.root_run_id`:
     * a trigger refuses one neither has (migration 0093).
     */
    runId: text("run_id").notNull(),
    stepKey: text("step_key").notNull(),
    attempt: integer().notNull(),
    generation: integer().notNull(),
    rootRunId: text("root_run_id")
      .notNull()
      .references(() => runLineages.rootRunId),
    reservedMs: integer("reserved_ms").notNull(),
    /** When the engine gives up on the attempt: the most it can use ends here. */
    deadline: timestamp("deadline").notNull(),
    usedMs: integer("used_ms"),
    admittedAt: timestamp("admitted_at").notNull(),
    settledAt: timestamp("settled_at"),
    policyGeneration: integer("policy_generation").notNull(),
    /**
     * Host calls the attempt reserved of its lineage while it runs, then,
     * once it settled, those it made; all it reserved if it never did.
     */
    hostCalls: integer("host_calls").notNull().default(0),
    /**
     * Who the attempt's run acts for (a user ID) and its App: whose shares
     * of the attempts running at once it takes while it holds
     * (src/workflows/admission.ts).
     */
    subject: text().notNull().default(""),
    resource: text().notNull().default(""),
    /**
     * The SHA-256 of the attempt's step name: whose place in the queue its
     * lease ends, and an older attempt of the step's late refusal may not
     * put back (src/workflows/admission.ts).
     */
    stepHash: text("step_hash").notNull().default(""),
    /**
     * Whether the attempt's own settle gave back the host calls it
     * reserved and didn't make (src/workflows/quotas.ts): once only, also
     * after the engine fenced it and its receipt settled sooner.
     */
    callsSettled: integer("calls_settled", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.stepKey, table.attempt, table.generation],
    }),
    // A lineage's attempts still holding, by when they were admitted: what
    // an admission settles once their allowance has passed, and how long a
    // refusal for a busy lineage says to wait.
    index("run_lineage_attempts_held_idx")
      .on(table.rootRunId, table.admittedAt)
      .where(sql`settled_at IS NULL`),
    // The attempts running at once, in all, for a person and of an App:
    // what fair admission counts (src/workflows/admission.ts), each until
    // its hold ends, an attempt's wall time at most after its admission.
    index("run_lineage_attempts_running_idx")
      .on(table.admittedAt)
      .where(sql`settled_at IS NULL`),
    index("run_lineage_attempts_subject_idx")
      .on(table.subject, table.admittedAt)
      .where(sql`settled_at IS NULL`),
    index("run_lineage_attempts_resource_idx")
      .on(table.resource, table.admittedAt)
      .where(sql`settled_at IS NULL`),
  ]
);

/**
 * The client's queue of workflow attempts waiting for a share of the
 * attempts running at once (src/workflows/admission.ts): one entry per
 * step of a run refused for want of one, by the SHA-256 of the step's
 * name (a keyed step's name holds the run's data), with who the run acts
 * for, its App, its turn (one past the latest turn of the places of the
 * same person and App waiting as it joined), when it joined and when it last asked. Places
 * are served by turn, then by when they joined: round-robin between the
 * people waiting in an App, first come, first served within each. An
 * entry that hasn't asked for a while is no longer waiting, and goes; the
 * step's next attempt joins at the back.
 */
export const workflowAdmissionQueue = sqliteTable(
  "workflow_admission_queue",
  {
    runId: text("run_id").notNull(),
    stepHash: text("step_hash").notNull(),
    subject: text().notNull(),
    resource: text().notNull(),
    enqueuedAt: timestamp("enqueued_at").notNull(),
    seenAt: timestamp("seen_at").notNull(),
    /** Which share it waits for: `client`, `person` or `app`. */
    waitingFor: text("waiting_for", {
      enum: ["client", "person", "app"],
    }).notNull(),
    /** When it asks again at the latest: the run's summary shows it. */
    retryAt: timestamp("retry_at").notNull(),
    turn: integer().notNull(),
    /**
     * The deadline of the step's attempt that last wrote the place: which
     * attempt owns it. An older attempt of the step (an earlier deadline)
     * neither writes nor gives up a place a newer one wrote.
     */
    attemptDeadline: timestamp("attempt_deadline").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.stepHash] }),
    // The places still asking, in the order they are served.
    index("workflow_admission_queue_order_idx").on(
      table.seenAt,
      table.turn,
      table.enqueuedAt
    ),
    // The places of a person, and of an App: their caps, and their turns.
    index("workflow_admission_queue_subject_idx").on(
      table.subject,
      table.resource,
      table.seenAt
    ),
    index("workflow_admission_queue_resource_idx").on(
      table.resource,
      table.seenAt
    ),
  ]
);

/**
 * The build jobs building now, a lease each (src/build-admission.ts): the
 * client's share of build jobs at once, and each App's, held to the quota
 * policy (`tenantBuildJobs`, `keyBuildJobs`). A lease counts while it is
 * unsettled, up to `admitted_at + reserved_ms` at most, whatever becomes
 * of the step that took it. One row per lease a job's step took, in the
 * order of the job's own sequence (`seq`): its step, the round it waited
 * and the engine's attempt.
 */
export const buildLeases = sqliteTable(
  "build_leases",
  {
    jobId: text("job_id").notNull(),
    seq: integer().notNull(),
    /** The person the job's chat is: whose turn among an App's places it takes. */
    subject: text().notNull(),
    /** The job's App: its key, of which one job builds at once. */
    resource: text().notNull(),
    admittedAt: timestamp("admitted_at").notNull(),
    reservedMs: integer("reserved_ms").notNull(),
    settledAt: timestamp("settled_at"),
    policyGeneration: integer("policy_generation").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.seq] }),
    // By when they were taken: what admission counts (those unsettled),
    // what a lease checks it still holds by (any taken since it ended),
    // and what retention drops.
    index("build_leases_admitted_idx").on(table.admittedAt),
    index("build_leases_resource_idx")
      .on(table.resource, table.admittedAt)
      .where(sql`settled_at IS NULL`),
  ]
);

/**
 * A build job's commit, fenced by its lease (src/build-admission.ts): a
 * row written first in the commit's own transaction, and removed last.
 * The database refuses the row, and so the whole commit, unless the lease
 * named still holds as the transaction runs (the trigger in migration
 * 0091): a commit whose step stalled past its lease never lands beside
 * another job of its App.
 */
export const buildCommitFences = sqliteTable(
  "build_commit_fences",
  {
    jobId: text("job_id").notNull(),
    seq: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.jobId, table.seq] })]
);

/**
 * The build jobs waiting for a lease (src/build-admission.ts), one place
 * per job, served as workflow attempts' places are (src/workflows/
 * admission.ts): by turn, then first come, first served, never behind an
 * App whose own share is full. A place lasts while its job asks again.
 */
export const buildAdmissionQueue = sqliteTable(
  "build_admission_queue",
  {
    jobId: text("job_id").primaryKey(),
    subject: text().notNull(),
    resource: text().notNull(),
    enqueuedAt: timestamp("enqueued_at").notNull(),
    seenAt: timestamp("seen_at").notNull(),
    /** Which share it waits for: the client's, its person's, or its App's (`key`). */
    waitingFor: text("waiting_for", {
      enum: ["client", "person", "key"],
    }).notNull(),
    /** When it asks again at the latest: the job's view shows it. */
    retryAt: timestamp("retry_at").notNull(),
    turn: integer().notNull(),
    /**
     * The job's sequence as it last wrote the place: an older step or
     * attempt of the job neither writes nor gives up a place a newer one
     * wrote.
     */
    ownerSeq: integer("owner_seq").notNull(),
  },
  (table) => [
    index("build_admission_queue_order_idx").on(
      table.seenAt,
      table.turn,
      table.enqueuedAt
    ),
    index("build_admission_queue_subject_idx").on(
      table.subject,
      table.resource,
      table.seenAt
    ),
    index("build_admission_queue_resource_idx").on(
      table.resource,
      table.seenAt
    ),
  ]
);

/**
 * The steps of workflow runs whose model call waits in the model ledger's
 * queue for a share of the model requests in flight (model-admission.ts),
 * so the run's summary shows it queued (src/workflows/model-waits.ts): one
 * row per step while its call waits, refreshed each time it asks again,
 * gone once it stops. One whose call stopped asking (its isolate died)
 * lapses as a workflow step's place does, and is pruned.
 */
export const workflowModelWaits = sqliteTable(
  "workflow_model_waits",
  {
    runId: text("run_id").notNull(),
    stepHash: text("step_hash").notNull(),
    /** The call of the step that wrote it: only it clears it (model-waits.ts). */
    owner: text().notNull(),
    /**
     * Which share its call waits for: `client`, `person` or `app`; null
     * once the call that owns the row stopped waiting (a tombstone, so an
     * older call's late note can't bring the wait back: model-waits.ts).
     */
    waitingFor: text("waiting_for", {
      enum: ["client", "person", "app"],
    }),
    /** When its call asks again at the latest. */
    retryAt: timestamp("retry_at").notNull(),
    /** When its call last asked: it lapses a while after. */
    seenAt: timestamp("seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.stepHash] }),
    // The waits still asking, and those to prune.
    index("workflow_model_waits_seen_idx").on(table.seenAt),
  ]
);

/**
 * The token core put on each address of the deployment's mail domain that
 * a workflow run's step mailed through a native mail connector
 * (src/workflows/mail-stamps.ts): `local+<token>@domain`. Mail back to
 * the tokened address starts its runs under the run, in its lineage, only
 * when it goes to `address` (the address the run mailed, without the
 * token) and comes from one of `senders` (the mailbox the run sent from,
 * and its connection's account). `origin` is the SHA-256 of the step's
 * key, the connection and the address, so the same call made again under
 * its key carries the same token. Removed with its run's details
 * (src/workflows/retention.ts).
 */
export const runMailStamps = sqliteTable(
  "run_mail_stamps",
  {
    token: text().primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id),
    origin: text().notNull(),
    address: text().notNull(),
    senders: text({ mode: "json" }).$type<string[]>().notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("run_mail_stamps_origin_idx").on(table.origin),
    index("run_mail_stamps_run_idx").on(table.runId),
  ]
);

/**
 * What each mail call of a workflow run's step was sent with
 * (src/workflows/mail-stamps.ts): its recipients that carry a token, as
 * they were and as they went, none for a call that stamped nothing; and,
 * for a native mail connector's call, the call's stamp, which its message
 * carries as a header, with every recipient the call named and who sent
 * it (the mailbox it names, its connection's account and that account's
 * email address). A copy of the message that reaches a watched mailbox
 * starts its runs under the run only when the mailbox is one of
 * `recipients` and its From one of `senders`. Keyed by the SHA-256 of the
 * step's key, the connection, the action and the call's input, so the
 * same call made again under its key sends what it sent the first time,
 * whatever core learned since. Removed with its run's details
 * (src/workflows/retention.ts).
 */
export const runMailCalls = sqliteTable(
  "run_mail_calls",
  {
    origin: text().primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id),
    replaced: text({ mode: "json" }).$type<Record<string, string>>().notNull(),
    createdAt: timestamp("created_at").notNull(),
    stamp: text(),
    recipients: text({ mode: "json" }).$type<string[]>(),
    senders: text({ mode: "json" }).$type<string[]>(),
  },
  (table) => [
    index("run_mail_calls_run_idx").on(table.runId),
    uniqueIndex("run_mail_calls_stamp_idx").on(table.stamp),
  ]
);

/**
 * The messages that claimed each stamp at each source of connector events
 * (src/workflows/mail-stamps.ts): a source is a connection and the
 * mailbox it reads (`[connection, resource]`), and a message is what an
 * event there that names the stamp is about (`eventKey`, the SHA-256 of
 * its connection and ID). At most a few per stamp and source
 * (`maxClaimsPerSource`): each starts runs under the stamp's run there,
 * the same event delivered again included, and any message past them is
 * a root. Removed with its run's details (src/workflows/retention.ts).
 */
export const runMailStampClaims = sqliteTable(
  "run_mail_stamp_claims",
  {
    stamp: text().notNull(),
    source: text().notNull(),
    eventKey: text("event_key").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.stamp, table.source, table.eventKey] }),
  ]
);

/**
 * Each run a stamp's run lineage refused to start
 * (src/workflows/connector-events.ts), by the trigger key it would have
 * had, with the stamp that made it the lineage's: its refusal is audited
 * once, however often its event is delivered again. Removed with the
 * stamp's run's details (src/workflows/retention.ts).
 */
export const runMailStampRefusals = sqliteTable(
  "run_mail_stamp_refusals",
  {
    triggerKey: text("trigger_key").primaryKey(),
    stamp: text().notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [index("run_mail_stamp_refusals_stamp_idx").on(table.stamp)]
);

/**
 * An App's accounts in a run lineage (src/workflows/quotas.ts,
 * `accountClaimed`): at most two per App, each the first run of its kind
 * in the lineage of `root_run_id`, claimed once, so every run charged to
 * it (`workflow_runs.account_run_id`) is charged to the one account, whose
 * `run_lineages` row counts its attempts and host calls. Never changed
 * or deleted (migration 0112's triggers).
 */
export const runLineageAccounts = sqliteTable(
  "run_lineage_accounts",
  {
    rootRunId: text("root_run_id")
      .notNull()
      .references(() => runLineages.rootRunId),
    appId: text("app_id").notNull(),
    /**
     * `joined` for an App's runs in a lineage another App started,
     * `rejoined` for the root's App's runs under another App's run.
     */
    kind: text({ enum: ["joined", "rejoined"] }).notNull(),
    accountRunId: text("account_run_id").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.rootRunId, table.appId, table.kind] }),
  ]
);

/**
 * The children each run lineage admitted by a trigger's key
 * (src/workflows/quotas.ts, `admitChild`): a delivery of the same message
 * admitted again, at once or later, is the same child, in the same place,
 * and takes no other slot of its lineage. Removed with its run's details
 * (src/workflows/retention.ts).
 */
export const runLineageChildren = sqliteTable("run_lineage_children", {
  triggerKey: text("trigger_key").primaryKey(),
  rootRunId: text("root_run_id")
    .notNull()
    .references(() => runLineages.rootRunId),
  depth: integer().notNull(),
  createdAt: timestamp("created_at").notNull(),
});

/**
 * The domains Email Routing delivered mail for (src/workflows/
 * inbound-email.ts): the deployment's mail domain, learned from the
 * envelope recipient Email Routing sets, which no sender can choose. A
 * run's mail to an address on one is stamped (`run_mail_stamps`).
 */
export const mailDomains = sqliteTable("mail_domains", {
  domain: text().primaryKey(),
  firstSeenAt: timestamp("first_seen_at").notNull(),
});

/**
 * Each quota policy generation core has applied (src/workflows/quotas.ts):
 * the limits the deployment's `QUOTA_LIMITS` set under it, as canonical
 * JSON, and their SHA-256. Written the first time core sees a generation,
 * never changed after: a later var that sets other limits under a
 * generation recorded here, or a lower generation than the highest, is
 * refused, and core keeps the highest generation's limits. So two
 * policies never share a generation, and none goes back to an older one,
 * whatever is deployed.
 */
export const quotaPolicies = sqliteTable("quota_policies", {
  generation: integer().primaryKey(),
  limits: text().notNull(),
  limitsHash: text("limits_hash").notNull(),
  recordedAt: timestamp("recorded_at").notNull(),
});

/**
 * Each pause, resume or cancel of a run that the host admitted
 * (src/workflows/controls.ts): its durable receipt. `admitted` until the
 * engine confirms it (`applied`), or a cancel supersedes a pause or resume
 * still unresolved (`superseded`). At most one unresolved receipt of each
 * kind a run: the same request again joins it. `generation` is the run's
 * control generation it was admitted under.
 */
export const workflowRunControls = sqliteTable(
  "workflow_run_controls",
  {
    id: text().primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id),
    kind: text({ enum: ["pause", "resume", "cancel"] }).notNull(),
    state: text({ enum: ["admitted", "applied", "superseded"] }).notNull(),
    generation: integer().notNull(),
    /** Who asked for it: a person, by their user ID. */
    requestedBy: text("requested_by").notNull(),
    createdAt: timestamp("created_at").notNull(),
    settledAt: timestamp("settled_at"),
    /**
     * When the repair next sends it again (src/workflows/controls.ts),
     * moved on further each time it does, so receipts that never settle
     * don't keep newer ones waiting.
     */
    retryAt: timestamp("retry_at").notNull(),
    /** How often the repair sent it again. */
    retries: integer().notNull().default(0),
  },
  (table) => [
    uniqueIndex("workflow_run_controls_unresolved_idx")
      .on(table.runId, table.kind)
      .where(sql`state = 'admitted'`),
    // The repair (src/workflows/controls.ts): receipts the engine is
    // still to confirm, next due first.
    index("workflow_run_controls_admitted_idx")
      .on(table.retryAt, table.id)
      .where(sql`state = 'admitted'`),
  ]
);

/**
 * Wakes core owes waiting runs (src/workflows/wakes.ts): one row per
 * outstanding wake, written in the same batch as what it wakes the run
 * for (a decision's answer), or before it (a held side effect's
 * decision, which connect keeps), and deleted once the engine took the
 * event. `id` is the delivery's key, which the engine takes once, and
 * `type` the event type the run's wait waits for. The run is an App's
 * (`run_id`) or an independent workflow's (`resource_run_id`), exactly
 * one of them: the engine knows either by its ID.
 */
export const workflowRunWakes = sqliteTable(
  "workflow_run_wakes",
  {
    id: text().primaryKey(),
    runId: text("run_id").references(() => workflowRuns.id),
    resourceRunId: text("resource_run_id").references(
      // oxlint-disable-next-line no-use-before-define -- declared with the independent runs, below
      () => workflowResourceRuns.id
    ),
    type: text().notNull(),
    createdAt: timestamp("created_at").notNull(),
    /**
     * When the repair next sends it, moved on further each time it does,
     * so a wake the engine keeps refusing doesn't keep newer ones waiting.
     */
    retryAt: timestamp("retry_at").notNull(),
    /** How often the repair sent it. */
    retries: integer().notNull().default(0),
    /**
     * Set on a wake owed before what it is for is known to have happened
     * (a held side effect's decision, still with connect): sent again by
     * the repair, each time as a new delivery, until then, and dropped
     * after. None on a wake the engine settles by taking it once.
     */
    resendUntil: timestamp("resend_until"),
  },
  (table) => [
    check(
      "workflow_run_wakes_one_run",
      // Unqualified: a check naming its table by name would keep the name
      // of the table its migration made it in.
      sql`(run_id IS NULL) <> (resource_run_id IS NULL)`
    ),
    // The repair (src/workflows/wakes.ts): next due first.
    index("workflow_run_wakes_due_idx").on(table.retryAt, table.id),
    // The repair's drop of wakes sent again for as long as they may be.
    index("workflow_run_wakes_resend_idx")
      .on(table.resendUntil)
      .where(sql`resend_until IS NOT NULL`),
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
    /**
     * Whether the run's starter never answers it, even when it names
     * exactly them (`person:<their id>`): set when the step takes its
     * reviewer only at run time (`StepOutline.dynamic`), so the starter
     * may have chosen it, and when its steps can't be read (R8).
     */
    starterExcluded: integer("starter_excluded", { mode: "boolean" })
      .notNull()
      .default(false),
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
 * One-use confirmations of a person's answer to a decision
 * (src/decisions/confirmations.ts), minted by the trusted host decision UI
 * once the person confirmed exactly what they answer, and taken by the
 * answer that uses it, in the same batch. Only the token's SHA-256 is
 * kept. Each binds the person, the decision, the review context they saw
 * (`context_fingerprint`) and the normalized response they confirmed
 * (`response_fingerprint`), until `expires_at`.
 */
export const workflowDecisionConfirmations = sqliteTable(
  "workflow_decision_confirmations",
  {
    tokenHash: text("token_hash").primaryKey(),
    decisionId: text("decision_id")
      .notNull()
      .references(() => workflowDecisions.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    contextFingerprint: text("context_fingerprint").notNull(),
    responseFingerprint: text("response_fingerprint").notNull(),
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    // Minting again replaces the person's earlier one for the decision.
    index("workflow_decision_confirmations_decision_user_idx").on(
      table.decisionId,
      table.userId
    ),
    // Minting drops the expired ones.
    index("workflow_decision_confirmations_expires_idx").on(table.expiresAt),
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
    /**
     * Whose it is: an App (`app`, its ID) or an independent workflow
     * resource (`workflow`, its ID). No foreign key names both tables,
     * so a trigger refuses a subject neither has (migration 0097).
     */
    subjectType: text("subject_type", { enum: ["app", "workflow"] }).notNull(),
    subjectId: text("subject_id").notNull(),
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
      enum: ["pending", "approved", "denied", "retired", "revoked"],
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
    /** Who retired or revoked the approval, and when: null until then. */
    endedBy: text("ended_by"),
    endedAt: timestamp("ended_at"),
    /**
     * The policy generation retiring or revoking it moved on to: what was
     * pinned under an earlier one is what a retired approval keeps.
     */
    endedGeneration: integer("ended_generation"),
    endedReason: text("ended_reason"),
  },
  (table) => [
    // One request waits per subject: a second pending row is refused.
    uniqueIndex("dependency_requests_pending_idx")
      .on(table.subjectType, table.subjectId)
      .where(sql`status = 'pending'`),
    // The approval a subject got last (its status, and what a new request
    // is compared with).
    index("dependency_requests_subject_idx").on(
      table.subjectType,
      table.subjectId,
      table.status,
      table.decidedAt
    ),
    // Whether a graph is approved for a subject: a proposal, and admission.
    index("dependency_requests_graph_idx").on(
      table.subjectType,
      table.subjectId,
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
    /**
     * Whose it is: an App (`app`, its ID) or an independent workflow
     * resource (`workflow`, its ID). No foreign key names both tables,
     * so a trigger refuses a subject neither has (migration 0097).
     */
    subjectType: text("subject_type", { enum: ["app", "workflow"] }).notNull(),
    subjectId: text("subject_id").notNull(),
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
  (table) => [
    primaryKey({
      columns: [table.subjectType, table.subjectId, table.graphHash],
    }),
  ]
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
    /**
     * Whose it is: an App (`app`, its ID) or an independent workflow
     * resource (`workflow`, its ID). No foreign key names both tables,
     * so a trigger refuses a subject neither has (migration 0097).
     */
    subjectType: text("subject_type", { enum: ["app", "workflow"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    graphHash: text("graph_hash").notNull(),
    target: text().notNull(),
    holder: text().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.subjectType,
        table.subjectId,
        table.graphHash,
        table.target,
      ],
    }),
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
    /**
     * Whose it is: an App (`app`, its ID) or an independent workflow
     * resource (`workflow`, its ID). No foreign key names both tables,
     * so a trigger refuses a subject neither has (migration 0097).
     */
    subjectType: text("subject_type", { enum: ["app", "workflow"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    graphHash: text("graph_hash").notNull(),
    targets: text().notNull(),
    policyGeneration: integer("policy_generation").notNull(),
    reason: text().notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.subjectType,
        table.subjectId,
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
 * Who owns each workflow (workflows/owners.ts): the person who answers
 * for it, shown on its line and told about its failures; one row per App
 * and workflow, kept across the App's versions. A workflow without one is
 * owned by its App's owner. Who owns it never changes whom its runs act
 * for. `set_by` set it last.
 */
export const workflowOwners = sqliteTable(
  "workflow_owners",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    workflowId: text("workflow_id").notNull(),
    ownerId: text("owner_id").notNull(),
    setBy: text("set_by").notNull(),
    setAt: timestamp("set_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.appId, table.workflowId] })]
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
 * Apps people asked Grasp to add, as the catalog doesn't have them
 * (app-requests.ts): one row each, by its name in lower case, so the
 * same app asked for twice is one request.
 */
export const appRequests = sqliteTable(
  "app_requests",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    nameKey: text("name_key").notNull(),
    why: text(),
    url: text(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at").notNull(),
  },
  (table) => [
    uniqueIndex("app_requests_name_key_idx").on(table.nameKey),
    index("app_requests_requested_at_idx").on(table.requestedAt),
  ]
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
    /**
     * The alias of the guests binding a sealed function invited it through
     * (resource-guests.ts): its link works only while an active binding of
     * that alias still names its permission. Null for one an App's v1
     * server invited, under its permission alone.
     */
    bindingAlias: text("binding_alias"),
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
 * What an explicit migration's dry run on a sample of real records found
 * (migration-samples.ts): its receipt, kept with the version's migration
 * evidence, which the release's sealed manifest holds for its fixtures.
 * Counts and codes only: no record's values, fields or IDs. `outcome` is
 * `passed`, `failed` or `empty` (no record left for it to transform);
 * `reason` the failure's code. The release it ran (`manifest_hash`) and the
 * schemas it ran between name what the sample vouches for. The latest
 * receipt of a migration decides; earlier ones stay as history.
 */
export const migrationSamples = sqliteTable(
  "migration_samples",
  {
    id: text().primaryKey(),
    appId: text("app_id").notNull(),
    version: integer().notNull(),
    migration: text().notNull(),
    storeId: text("store_id").notNull(),
    outcome: text({ enum: ["passed", "failed", "empty"] }).notNull(),
    rows: integer().notNull(),
    owners: integer().notNull(),
    reason: text(),
    manifestHash: text("manifest_hash").notNull(),
    fromSchema: text("from_schema").notNull(),
    toSchema: text("to_schema").notNull(),
    sampledBy: text("sampled_by").notNull(),
    sampledAt: timestamp("sampled_at").notNull(),
  },
  (table) => [
    index("migration_samples_latest_idx").on(
      table.appId,
      table.version,
      table.migration,
      table.sampledAt
    ),
  ]
);

/**
 * The leases migration dry runs were granted (migration-samples.ts), one
 * row per run: taken before its sample is read, while no other run of
 * the same migration of a version holds one (`until` still ahead; a run
 * that died mid-way holds it until then) and fewer than a few were
 * granted in the last minute, counted here whether or not the run got
 * as far as its receipt. Let go as the run ends, `until` set to then.
 * `id` is the run's own token, so only it lets its lease go. Rows past
 * the minute and let go are pruned as the next lease is taken.
 */
export const migrationSampleLeases = sqliteTable(
  "migration_sample_leases",
  {
    id: text().primaryKey(),
    appId: text("app_id").notNull(),
    version: integer().notNull(),
    migration: text().notNull(),
    grantedAt: timestamp("granted_at").notNull(),
    until: timestamp("until").notNull(),
  },
  (table) => [
    index("migration_sample_leases_migration_idx").on(
      table.appId,
      table.version,
      table.migration,
      table.grantedAt
    ),
  ]
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
  /**
   * The store's creator, the user who created it, and so its owner. Who
   * owns each record is the record's own `_ownerId`, never this.
   */
  ownerId: text("owner_id").notNull(),
  /**
   * The definition (`business_store_versions`) the release of the current
   * version of the App the store serves binds, moved in the statement that
   * makes that version current (apps.ts), and null while that version
   * binds the store none: a projection, never what the store's object
   * accepts writes against.
   */
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
  /**
   * When a deletion of the store began, if one is in flight: set before
   * its object is closed, only while no sealed release binds the store,
   * and while set (for `storeClosingMs`) no seal binds it and no version
   * bound to it is made current (data-stores.ts, app-releases.ts,
   * apps.ts). Cleared, by its owner alone, if the close is refused; a
   * deletion finished sets `deletedAt`.
   */
  closingAt: timestamp("closing_at"),
  /** The deletion that set `closingAt`: only it closes the store, or clears the mark. */
  closingOwner: text("closing_owner"),
});

/**
 * Who manages each business store besides the organization's admins and
 * its creator (src/data-stores.ts): a person (`member_type` `person`,
 * `member_id` their user ID) or a team, in role `manage`. Unsharing
 * deletes the row; who did which is in the audit log.
 */
export const businessStoreMembers = sqliteTable(
  "business_store_members",
  {
    storeId: text("store_id")
      .notNull()
      .references(() => businessStores.id),
    memberType: text("member_type", { enum: ["person", "team"] }).notNull(),
    memberId: text("member_id").notNull(),
    role: text({ enum: ["manage"] }).notNull(),
    addedBy: text("added_by").notNull(),
    addedAt: timestamp("added_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.memberType, table.memberId] }),
    index("business_store_members_member_idx").on(
      table.memberType,
      table.memberId
    ),
  ]
);

/**
 * The deployment's independent workflows (spec 3, 13.2, 24;
 * src/workflow-resources.ts): each a resource of its own, owned by the
 * person who created it, never by an App, so nothing done to an App
 * (sharing, grouping, deleting) reaches it. Its ID is minted at random by
 * the host; its name is fixed at creation and unique among every workflow
 * there has been, deleted ones included, until an admin releases a deleted
 * one's name (`name_released_at`, GRA-562): then a new workflow may take
 * it. `current_version` is the version published last. A deleted workflow
 * keeps its row, with `deleted_at` set, and is never served again.
 */
export const workflowResources = sqliteTable(
  "workflow_resources",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    ownerId: text("owner_id").notNull(),
    currentVersion: integer("current_version"),
    createdAt: timestamp("created_at").notNull(),
    deletedAt: timestamp("deleted_at"),
    /**
     * Moves on with every change of who may start or follow it: its members,
     * and grants and revocations of permissions on it or of it
     * (workflow-starts.ts). A start admitted under one generation is refused
     * once it moved, so no start lands on authority that changed under it.
     */
    policyGeneration: integer("policy_generation").notNull().default(1),
    /**
     * The parameter revision in force (`workflow_resource_params`): 0 while
     * no value was ever set. Every edit names the revision it read and
     * moves it on; a start freezes the values of the revision it read, and
     * is refused if an edit landed in between (workflow-starts.ts).
     */
    configRevision: integer("config_revision").notNull().default(0),
    /**
     * When an admin released the name of this deleted workflow, and who: it
     * no longer holds the name, which a new workflow may take. Set once, on
     * a deleted row only, and never cleared; the row is never live again
     * (migration 0107's triggers).
     */
    nameReleasedAt: timestamp("name_released_at"),
    nameReleasedBy: text("name_released_by"),
  },
  (table) => [
    // Listing reads a person's own workflows by owner (`listWorkflowResources`).
    index("workflow_resources_owner_idx").on(table.ownerId),
    // Unique among the workflows that hold their name: every one but those
    // whose name was released.
    uniqueIndex("workflow_resources_name_unique")
      .on(table.name)
      .where(sql`name_released_at IS NULL`),
    // Every read by name, released holders' included
    // (`requireUnreleasedVersion`, `releaseWorkflowName`): the partial
    // index above serves only those that say `name_released_at IS NULL`.
    index("workflow_resources_name_released").on(
      table.name,
      table.nameReleasedAt
    ),
  ]
);

/**
 * Each published version of a workflow: written once, by its publication,
 * and never changed. `version` counts publications from 1;
 * `definition_version` is the definition's own semantic version, unique
 * per workflow, so a semantic version always names the same content.
 * `definition` is the workflow.json exactly as published (at most the
 * profile's 1 MiB), `contract` the canonical JSON of its input, output and
 * parameter schemas, and `manifest` the canonical JSON of what the version
 * pins: its definition, profile, evaluator, contract and the exact versions
 * its bindings resolved to (also in `sdk_resource_bindings`), each with
 * its SHA-256.
 */
export const workflowResourceVersions = sqliteTable(
  "workflow_resource_versions",
  {
    workflowResourceId: text("workflow_resource_id")
      .notNull()
      .references(() => workflowResources.id),
    version: integer().notNull(),
    definitionVersion: text("definition_version").notNull(),
    definition: text().notNull(),
    definitionJsonHash: text("definition_json_hash").notNull(),
    profileVersion: text("profile_version").notNull(),
    evaluatorHash: text("evaluator_hash").notNull(),
    contract: text().notNull(),
    contractHash: text("contract_hash").notNull(),
    manifest: text().notNull(),
    manifestHash: text("manifest_hash").notNull(),
    authorId: text("author_id").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workflowResourceId, table.version] }),
    uniqueIndex("workflow_resource_versions_definition_version").on(
      table.workflowResourceId,
      table.definitionVersion
    ),
  ]
);

/**
 * Whom each workflow is shared with (src/workflow-resources.ts): a person
 * (`member_type` `person`, `member_id` their user ID) or a team, in role
 * `user` or `builder`. Sharing again changes the role; unsharing deletes
 * the row; who did which is in the audit log. Its owner has no row.
 */
export const workflowResourceMembers = sqliteTable(
  "workflow_resource_members",
  {
    workflowResourceId: text("workflow_resource_id")
      .notNull()
      .references(() => workflowResources.id),
    memberType: text("member_type", { enum: ["person", "team"] }).notNull(),
    memberId: text("member_id").notNull(),
    role: text({ enum: ["user", "builder"] }).notNull(),
    addedBy: text("added_by").notNull(),
    addedAt: timestamp("added_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workflowResourceId, table.memberType, table.memberId],
    }),
    index("workflow_resource_members_member_idx").on(
      table.memberType,
      table.memberId
    ),
  ]
);

/**
 * Independent triggers (spec 15, 24; src/trigger-resources.ts): what
 * starts one exact workflow version on its own (a system event, a
 * connector event, a webhook, a schedule), owned by whoever created it,
 * never by the workflow's owner or an App. `current_version` names the
 * version (`trigger_resource_versions`) future starts use; `enabled` false,
 * or `deleted_at`, stops future starts, never runs already started. Its
 * starts need a permission of its own (`start` on the workflow) like any
 * other subject's.
 */
export const triggerResources = sqliteTable("trigger_resources", {
  id: text().primaryKey(),
  ownerId: text("owner_id").notNull(),
  kind: text({
    enum: ["system", "connector", "webhook", "schedule"],
  }).notNull(),
  currentVersion: integer("current_version").notNull(),
  enabled: integer({ mode: "boolean" }).notNull(),
  createdAt: timestamp("created_at").notNull(),
  deletedAt: timestamp("deleted_at"),
});

/**
 * Each version of a trigger, written once: the exact workflow version it
 * starts (never "the latest": a new workflow version changes no trigger
 * until one is explicitly updated to it), the SHA-256 of its
 * configuration, and the person its starts act for (`principal_binding`,
 * a user ID the host bound at creation: who created it, never the
 * workflow's owner).
 */
export const triggerResourceVersions = sqliteTable(
  "trigger_resource_versions",
  {
    triggerId: text("trigger_id")
      .notNull()
      .references(() => triggerResources.id),
    version: integer().notNull(),
    workflowResourceId: text("workflow_resource_id")
      .notNull()
      .references(() => workflowResources.id),
    workflowResourceVersion: integer("workflow_resource_version").notNull(),
    configHash: text("config_hash").notNull(),
    principalBinding: text("principal_binding").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.triggerId, table.version] })]
);

/**
 * Each start of an independent workflow the host admitted
 * (src/workflow-starts.ts): its durable receipt, written in one statement
 * with the authorization it was admitted on, read again as the statement
 * ran. One per invoker, person it acts for and idempotency key, so the
 * same start sent again is the same start, and one person's key never
 * reaches another's start. It pins the exact workflow version and manifest, who
 * invoked it (a person, an App, an agent or a trigger, with the App
 * version or trigger version), the person it acts for, the workflow's
 * policy generation it was admitted under and its validated input
 * (canonical JSON, with its SHA-256). Never changed after, but for its
 * input and frozen parameter values, which run retention removes
 * (workflows/retention.ts): set to null once, with `details_removed_at`,
 * while every ID, hash and link stays, as the database enforces.
 */
export const workflowStartReceipts = sqliteTable(
  "workflow_start_receipts",
  {
    id: text().primaryKey(),
    invokerType: text("invoker_type", {
      enum: ["person", "app", "agent", "trigger"],
    }).notNull(),
    invokerId: text("invoker_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    workflowResourceId: text("workflow_resource_id")
      .notNull()
      .references(() => workflowResources.id),
    workflowResourceVersion: integer("workflow_resource_version").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    /** The App version, for an App's start; null otherwise. */
    originAppVersion: integer("origin_app_version"),
    /** The trigger version, for a trigger's start; null otherwise. */
    triggerVersion: integer("trigger_version"),
    principalId: text("principal_id").notNull(),
    authorityGeneration: integer("authority_generation").notNull(),
    /** The validated input; null once retention removed it. */
    input: text(),
    inputHash: text("input_hash").notNull(),
    /**
     * The parameter values the start froze (canonical JSON of every
     * parameter's value: set, or its default), and the revision they were
     * read at; null once retention removed them. Sensitive values
     * included: a receipt is never listed or audited with them, nor with a
     * hash of them, which a guess at a short value could be checked
     * against.
     */
    params: text(),
    paramsRevision: integer("params_revision").notNull().default(0),
    /**
     * The bindings the start froze (canonical JSON: each alias, its kind,
     * contract and fingerprint, and the exact workflow version or approved
     * target serving it), and their SHA-256.
     */
    bindings: text().notNull().default("[]"),
    bindingsHash: text("bindings_hash").notNull().default(""),
    createdAt: timestamp("created_at").notNull(),
    /** When retention removed its input and parameter values. */
    detailsRemovedAt: timestamp("details_removed_at"),
    /**
     * Whether the start was decided in restricted mode (restricted.ts): an
     * App's start while the App, or the chat of the agent whose call made
     * it, had read restricted data. Its run is restricted for good.
     */
    restricted: integer({ mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    uniqueIndex("workflow_start_receipts_key").on(
      table.invokerType,
      table.invokerId,
      table.principalId,
      table.idempotencyKey
    ),
    index("workflow_start_receipts_workflow").on(
      table.workflowResourceId,
      table.createdAt
    ),
    // The receipts retention has yet to reach, oldest first.
    index("workflow_start_receipts_due")
      .on(table.createdAt)
      .where(sql`${table.detailsRemovedAt} IS NULL`),
  ]
);

/**
 * Each run of an independent workflow (src/workflows/resource-runs.ts):
 * the run a start's receipt admitted, under the receipt's own ID, written
 * in the receipt's statement for a version with an executable build. It
 * pins the exact version, its manifest and its build's executable
 * identity, and the person it acts for; the engine runs it (engine.ts,
 * pinned to the same) and is the only authority on where it is, which
 * `status` follows by the engine's notifications, each applied only if
 * newer than the last (`engine_sequence`). A run that hasn't ended keeps
 * its workflow from being deleted (workflow-resources.ts). It holds no
 * details: its input and parameters are the receipt's, its output and
 * failure the engine's, both under run retention.
 *
 * Not a `workflow_runs` row: those are an App's runs (`app_id` is
 * required), and making it optional would rebuild that table, which D1
 * can't do under the tables that reference it.
 */
export const workflowResourceRuns = sqliteTable(
  "workflow_resource_runs",
  {
    id: text()
      .primaryKey()
      .references(() => workflowStartReceipts.id),
    workflowResourceId: text("workflow_resource_id")
      .notNull()
      .references(() => workflowResources.id),
    version: integer().notNull(),
    manifestHash: text("manifest_hash").notNull(),
    buildHash: text("build_hash").notNull(),
    principalId: text("principal_id").notNull(),
    status: text({
      enum: ["starting", "running", "completed", "failed", "cancelled"],
    }).notNull(),
    engineSequence: integer("engine_sequence").notNull().default(0),
    createdAt: timestamp("created_at").notNull(),
    endedAt: timestamp("ended_at"),
    /**
     * How often the repair sent its start (workflows/resource-runs.ts), and
     * when it may next: each run backs off on its own, and ends failed
     * past a bound, so runs that can't start never crowd out newer ones.
     */
    startAttempts: integer("start_attempts").notNull().default(0),
    nextStartAt: timestamp("next_start_at"),
    /**
     * Why core ended a run the engine never had (its start abandoned), as
     * an error code with nothing of the run in it: the engine, which
     * holds every other run's error, has nothing to say of it.
     */
    failureCode: text("failure_code"),
    /**
     * The newest activation generation whose step attempts the engine has
     * fenced (workflows/quotas.ts, `sharesReleased`): an attempt of it, or
     * an older one, whose admission lands later takes no share. An ended
     * run takes none whatever this says, so it moves only while the run
     * hasn't ended.
     */
    sharesFencedThrough: integer("shares_fenced_through").notNull().default(0),
    /**
     * Its start's `restricted`, pinned with it: every call of the run reads
     * it here (restricted.ts), so no step, retry or replay runs without it.
     */
    restricted: integer({ mode: "boolean" }).notNull().default(false),
    /**
     * The timer the run waits on now, if any, as its host opened it
     * (workflows/resource-host.ts): a JSON object of its ID, task,
     * purpose (`sleep` or `retry`), when it opened and its deadline. What
     * a screen's snapshot of the run lists as its wait (spec 10.7.2).
     */
    timer: text(),
    /**
     * How often its timer opened or closed: part of its snapshot's
     * revision (screen-workflows.ts), so each is a revision of its own.
     */
    timerRevision: integer("timer_revision").notNull().default(0),
    /**
     * How many of its timers have passed, in the order its code reaches
     * them: a replay that reaches one of those again keeps nothing of it.
     */
    timersPassed: integer("timers_passed").notNull().default(0),
    /**
     * While the engine rolls the run back (its steps' compensations), why:
     * a JSON object of its cause (`failure` or `cancellation`) and, for a
     * failure, the code the run failed with. What a screen's snapshot shows
     * of its compensation (spec 10.7.3); kept once it ended.
     */
    compensation: text(),
  },
  (table) => [
    // A workflow's runs that haven't ended, for its deletion check.
    index("workflow_resource_runs_workflow_idx").on(
      table.workflowResourceId,
      table.status
    ),
    // Starts the engine is still to confirm, for the repair.
    index("workflow_resource_runs_starting_idx")
      .on(table.createdAt)
      .where(sql`${table.status} = 'starting'`),
    // A workflow's runs, newest first, for its page (`listResourceRuns`).
    index("workflow_resource_runs_newest_idx").on(
      table.workflowResourceId,
      table.createdAt,
      table.id
    ),
    // One person's runs of a workflow, newest first, for an App's
    // `workflows.<wf>.queries.runs` (workflow-reference-queries.ts).
    index("workflow_resource_runs_principal_idx").on(
      table.workflowResourceId,
      table.principalId,
      table.createdAt,
      table.id
    ),
  ]
);

/**
 * A workflow run's own files (GRA-724, workflows/run-files.ts): what its
 * actions write through a `files` binding and read back in later steps of
 * the same run. Its bytes are in R2 (`FILES`, EU), one object per chunk;
 * a file is its run's alone, found only with the run's ID, and goes with
 * the run's details (`sweepWorkflowStartDetails` marks it deleted, then
 * `sweepRunFiles` deletes its chunks and its row). No name or content of
 * it reaches the audit log.
 */
export const workflowRunFiles = sqliteTable(
  "workflow_run_files",
  {
    id: text().primaryKey(),
    runId: text("run_id").notNull(),
    workflowResourceId: text("workflow_resource_id").notNull(),
    /** The step whose task opened it: only that task writes it. */
    openedBy: text("opened_by").notNull(),
    /** The open's effect key: opening again with it answers this file. */
    openKey: text("open_key").notNull().unique(),
    name: text().notNull(),
    type: text().notNull(),
    /** Its bytes so far, reserved before they are stored. */
    size: integer().notNull().default(0),
    sha256: text(),
    state: text({ enum: ["writing", "done", "deleted"] }).notNull(),
    createdAt: timestamp("created_at").notNull(),
    finishedAt: timestamp("finished_at"),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("workflow_run_files_run_idx").on(table.runId, table.state),
    index("workflow_run_files_workflow_idx").on(
      table.workflowResourceId,
      table.state
    ),
    // Unfinished files, oldest first, for the sweep.
    index("workflow_run_files_writing_idx")
      .on(table.createdAt)
      .where(sql`${table.state} = 'writing'`),
    // Deleted files, for the sweep that deletes their chunks.
    index("workflow_run_files_deleted_idx")
      .on(table.deletedAt)
      .where(sql`${table.state} = 'deleted'`),
  ]
);

/**
 * The chunks of a run file, in order: each its own R2 object, written
 * once with its SHA-256 and reserved (counted against the limits) before
 * it is stored. The append's effect key makes adding it again answer it.
 */
export const workflowRunFileChunks = sqliteTable(
  "workflow_run_file_chunks",
  {
    fileId: text("file_id").notNull(),
    index: integer().notNull(),
    key: text().notNull().unique(),
    appendKey: text("append_key").notNull().unique(),
    size: integer().notNull(),
    sha256: text().notNull(),
    stored: integer({ mode: "boolean" }).notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.fileId, table.index] })]
);

/**
 * Terminations core owes the engine for runs it ended while they were
 * still starting, cancelled or abandoned (workflows/resource-runs.ts):
 * the run's row ends at once and never changes again, so what is still
 * to tell the engine is kept here, written with that end, until the
 * engine confirms. The repair
 * sends each again, backing off, so an instance the engine made before
 * that end never keeps its lease or alarm.
 */
export const workflowResourceRunTerminations = sqliteTable(
  "workflow_resource_run_terminations",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => workflowResourceRuns.id),
    attempts: integer().notNull().default(0),
    nextAt: timestamp("next_at").notNull(),
  },
  (table) => [
    index("workflow_resource_run_terminations_next_idx").on(table.nextAt),
  ]
);

/**
 * The controls a person asked of an independent run through an App's
 * screen (screen-workflows.ts): one receipt per run and kind, whatever
 * key asked for it, so a request sent again while its answer was lost,
 * or asked again under another key, answers the same receipt rather than
 * ask twice. `admitted` until the run's stop is asked of the engine, then
 * `applied`, or `superseded` when the run ended otherwise first. Written
 * once and settled once (migration 0108's triggers). Only `cancel` for
 * now: an independent run can't be paused yet.
 */
export const workflowResourceRunControls = sqliteTable(
  "workflow_resource_run_controls",
  {
    id: text().primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowResourceRuns.id),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    principalId: text("principal_id").notNull(),
    key: text().notNull(),
    kind: text({ enum: ["cancel"] }).notNull(),
    state: text({ enum: ["admitted", "applied", "superseded"] }).notNull(),
    createdAt: timestamp("created_at").notNull(),
    settledAt: timestamp("settled_at"),
    /**
     * How often the repair applied it while it stayed admitted, and when it
     * may next (workflows/resource-runs.ts): each backs off on its own, so
     * one whose stop keeps failing never crowds out newer ones.
     */
    attempts: integer().notNull().default(0),
    nextAt: timestamp("next_at").notNull(),
    /**
     * When its stop was first asked of the engine, set once: what audits
     * that stop exactly once, however often it is asked again.
     */
    stopRequestedAt: timestamp("stop_requested_at"),
  },
  (table) => [
    uniqueIndex("workflow_resource_run_controls_kind_idx").on(
      table.runId,
      table.kind
    ),
    index("workflow_resource_run_controls_run_idx").on(
      table.runId,
      table.state
    ),
    index("workflow_resource_run_controls_due_idx").on(
      table.state,
      table.nextAt
    ),
  ]
);

/**
 * The host catalog of contracts independent workflows bind besides each
 * other (spec 13.2; src/workflow-catalog.ts): operation, connector, model
 * and decision contracts, each published once by an admin and never
 * changed, so a key always names the same descriptors. `contract` is the
 * canonical JSON a workflow's validation reads; `fingerprint` its SHA-256.
 */
export const workflowCatalogContracts = sqliteTable(
  "workflow_catalog_contracts",
  {
    key: text().primaryKey(),
    kind: text({
      enum: [
        "operation",
        "connector",
        "model",
        "decision",
        "event",
        "knowledge",
        "template",
        "files",
      ],
    }).notNull(),
    contract: text().notNull(),
    fingerprint: text().notNull(),
    publishedBy: text("published_by").notNull(),
    publishedAt: timestamp("published_at").notNull(),
  }
);

/**
 * Which concrete resource serves each catalog binding of an independent
 * workflow (src/workflow-bindings.ts): approved by an admin for the
 * declaration they reviewed (its kind, contract key and fingerprint) in
 * the exact version they reviewed (`reviewed_version`), and serving that
 * version alone: another version, newer or older, is code nobody reviewed
 * for it. `target` is the resource (JSON, `WorkflowBindingTarget`). At
 * most one active approval per version and alias; approving another
 * revokes it in the same batch. Revoked rows stay.
 */
export const workflowBindingApprovals = sqliteTable(
  "workflow_binding_approvals",
  {
    id: text().primaryKey(),
    workflowResourceId: text("workflow_resource_id")
      .notNull()
      .references(() => workflowResources.id),
    alias: text().notNull(),
    kind: text({
      enum: [
        "operation",
        "connector",
        "model",
        "decision",
        "event",
        "knowledge",
        "template",
        "files",
      ],
    }).notNull(),
    contractId: text("contract_id").notNull(),
    fingerprint: text().notNull(),
    target: text().notNull(),
    reviewedVersion: integer("reviewed_version").notNull(),
    status: text({ enum: ["active", "revoked"] }).notNull(),
    approvedBy: text("approved_by").notNull(),
    approvedAt: timestamp("approved_at").notNull(),
    revokedBy: text("revoked_by"),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [
    uniqueIndex("workflow_binding_approvals_active_idx")
      .on(table.workflowResourceId, table.reviewedVersion, table.alias)
      .where(sql`${table.status} = 'active'`),
  ]
);

/**
 * Each revision of an independent workflow's parameter values
 * (src/workflow-params.ts): written once per edit, never changed, numbered
 * from 1 per workflow; the workflow's `config_revision` names the one in
 * force. `values` is the canonical JSON of the values set (a parameter
 * left out has its default), sensitive ones included: they are never
 * listed, audited or returned, only frozen into a start. A revision no
 * longer in force has its values removed by run retention once it was
 * replaced that long ago (workflows/retention.ts): set to null once, with
 * `values_removed_at`, while the revision, who set it and when stay.
 */
export const workflowResourceParams = sqliteTable(
  "workflow_resource_params",
  {
    workflowResourceId: text("workflow_resource_id")
      .notNull()
      .references(() => workflowResources.id),
    revision: integer().notNull(),
    values: text(),
    setBy: text("set_by").notNull(),
    setAt: timestamp("set_at").notNull(),
    valuesRemovedAt: timestamp("values_removed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.workflowResourceId, table.revision] }),
  ]
);

/**
 * The draft of each independent workflow's next definition, as its
 * builders edit it (src/workflow-drafts.ts): one row per accepted edit,
 * `revision` counting them from 1. An edit names the revision it read and
 * inserts the next one, so of two concurrent edits the second is refused
 * and the first stays. `source` is the text as edited, JSON or not;
 * `problems` the profile's diagnostics of it (empty for one that passes),
 * so a row with `checked` set is a checkpoint: a definition that passed,
 * which the editor's diagram shows and which may be published. Only the
 * latest row and the latest checkpoint are kept.
 */
export const workflowResourceDrafts = sqliteTable(
  "workflow_resource_drafts",
  {
    workflowResourceId: text("workflow_resource_id")
      .notNull()
      .references(() => workflowResources.id),
    revision: integer().notNull(),
    source: text().notNull(),
    checked: integer({ mode: "boolean" }).notNull(),
    problems: text().notNull(),
    editedBy: text("edited_by").notNull(),
    editedAt: timestamp("edited_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workflowResourceId, table.revision] }),
  ]
);

/**
 * The modules each draft revision carries (src/workflow-drafts.ts), one
 * row per module: inserted with their revision, never changed, and kept
 * and removed with it. A row each keeps every row within what D1 holds,
 * however a revision's definition and modules add up.
 */
export const workflowResourceDraftModules = sqliteTable(
  "workflow_resource_draft_modules",
  {
    workflowResourceId: text("workflow_resource_id")
      .notNull()
      .references(() => workflowResources.id),
    revision: integer().notNull(),
    path: text().notNull(),
    source: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workflowResourceId, table.revision, table.path],
    }),
  ]
);

/**
 * What the sandbox's inspection of a draft revision's modules answered
 * (src/workflow-drafts.ts): kept with the revision, so a later edit that
 * carries exactly the same modules (`modules_hash`) checks its definition
 * against these contracts instead of running the modules again. Only an
 * inspection that succeeded is kept; a publication always inspects anew.
 */
export const workflowResourceDraftInspections = sqliteTable(
  "workflow_resource_draft_inspections",
  {
    workflowResourceId: text("workflow_resource_id")
      .notNull()
      .references(() => workflowResources.id),
    revision: integer().notNull(),
    modulesHash: text("modules_hash").notNull(),
    manifest: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workflowResourceId, table.revision] }),
  ]
);

/**
 * Which exact version of an independent workflow each App binds, by an
 * alias of the App's (src/app-workflow-bindings.ts). A binding pins the
 * version and grants nothing: starting it still takes the App's own
 * `start` permission. At most one active binding per App and alias;
 * moving to another version is a new binding. Removed ones stay.
 */
export const appWorkflowBindings = sqliteTable(
  "app_workflow_bindings",
  {
    id: text().primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    alias: text().notNull(),
    workflowResourceId: text("workflow_resource_id")
      .notNull()
      .references(() => workflowResources.id),
    workflowResourceVersion: integer("workflow_resource_version").notNull(),
    status: text({ enum: ["active", "removed"] }).notNull(),
    boundBy: text("bound_by").notNull(),
    boundAt: timestamp("bound_at").notNull(),
    removedBy: text("removed_by"),
    removedAt: timestamp("removed_at"),
  },
  (table) => [
    uniqueIndex("app_workflow_bindings_active_idx")
      .on(table.appId, table.alias)
      .where(sql`${table.status} = 'active'`),
    index("app_workflow_bindings_workflow_idx").on(
      table.workflowResourceId,
      table.status
    ),
  ]
);

/**
 * Test runs of a workflow's draft checkpoint, never published
 * (workflows/candidate-runs.ts, GRA-815): each of the exact checkpoint
 * revision it names, compiled when it started into a build of its own,
 * pinned by the manifest's hash (`manifest`, `manifest_hash`), whose
 * artifacts are reserved under `reservation` for as long as the row is.
 * Its input and parameters are frozen as it started (`input`, `params`:
 * the start's own values or the defaults, never the workflow's set ones),
 * and every named call it makes is answered from `fixtures`, never sent
 * anywhere. Not a `workflow_resource_runs` row: it is no run of a version,
 * nothing lists, binds or starts it but its workflow's builders, and it
 * is kept briefly. `status` follows the engine's notifications, each
 * applied only if newer than the last (`engine_sequence`).
 */
export const workflowCandidateRuns = sqliteTable(
  "workflow_candidate_runs",
  {
    id: text().primaryKey(),
    workflowResourceId: text("workflow_resource_id")
      .notNull()
      .references(() => workflowResources.id),
    draftRevision: integer("draft_revision").notNull(),
    manifest: text().notNull(),
    manifestHash: text("manifest_hash").notNull(),
    buildHash: text("build_hash").notNull(),
    reservation: text().notNull(),
    principalId: text("principal_id").notNull(),
    input: text().notNull(),
    params: text().notNull(),
    fixtures: text().notNull(),
    status: text({
      enum: ["starting", "running", "completed", "failed", "cancelled"],
    }).notNull(),
    engineSequence: integer("engine_sequence").notNull().default(0),
    /**
     * The newest activation generation whose attempts the engine fenced,
     * as an independent run's (workflows/quotas.ts, `fenceRecorded`).
     */
    sharesFencedThrough: integer("shares_fenced_through").notNull().default(0),
    /** Why core ended it, when the engine never had it (a start that failed). */
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at").notNull(),
    endedAt: timestamp("ended_at"),
  },
  (table) => [
    // A workflow's test runs, newest first, for its builders.
    index("workflow_candidate_runs_workflow_idx").on(
      table.workflowResourceId,
      table.createdAt,
      table.id
    ),
    // The sweep of test runs kept long enough.
    index("workflow_candidate_runs_created_idx").on(table.createdAt),
    // What keeps a build's artifacts reserved (release-retention.ts).
    uniqueIndex("workflow_candidate_runs_reservation_idx").on(
      table.reservation
    ),
  ]
);

/**
 * The application landscape's syncs (src/landscape.ts), one row per
 * landscape connection: the sync under way, or the last one. A sync reads
 * the connection's grants a page at a time, `cursor` the next page's,
 * each page written with the cursor that follows it, so a sync that
 * stopped goes on from its last page. Every row of a sync is written as
 * seen at `started_at`, so writing a page again writes the same.
 */
export const landscapeSyncs = sqliteTable("landscape_syncs", {
  connectionId: text("connection_id").primaryKey(),
  /** The UTC day it started, `YYYY-MM-DD`: one sync a day. */
  day: text().notNull(),
  startedAt: timestamp("started_at").notNull(),
  cursor: text(),
  reads: integer().notNull(),
  state: text({
    enum: ["running", "done", "partial", "failed"],
  }).notNull(),
  /** Why it failed, by code. */
  reason: text(),
  /** Throttled, or failed for now: not read again before. */
  retryAt: timestamp("retry_at"),
  finishedAt: timestamp("finished_at"),
  /**
   * When the last sync that read everything (`done`; never one stopped at
   * its bound) started: what its rows were last seen at counts as current.
   * Kept through later syncs until one of them reads everything; null
   * before any did.
   */
  currentSince: timestamp("current_since"),
});

/**
 * Each app a landscape connection's tenant granted access, as last seen:
 * its name and publisher as the provider says (data, never an identifier:
 * `app_id`, its client ID, is), and when an admin's consent for everyone
 * was last seen, with its scopes.
 */
export const landscapeApps = sqliteTable(
  "landscape_apps",
  {
    connectionId: text("connection_id").notNull(),
    appId: text("app_id").notNull(),
    name: text().notNull(),
    /** As the provider verified it; null when unverified. */
    publisher: text(),
    /** The name an unverified app gives its publisher: its word only. */
    unverifiedPublisher: text("unverified_publisher"),
    verified: integer({ mode: "boolean" }).notNull(),
    adminScopes: text("admin_scopes", { mode: "json" }).$type<string[]>(),
    adminSeenAt: timestamp("admin_seen_at"),
    firstSeen: timestamp("first_seen").notNull(),
    lastSeen: timestamp("last_seen").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.connectionId, table.appId] }),
    index("landscape_apps_last_seen_idx").on(table.lastSeen),
  ]
);

/**
 * Each person who granted an app access for themselves, by their ID at
 * the provider, as last seen: dropped once not seen for the landscape's
 * retention (src/landscape.ts).
 */
export const landscapeAppPeople = sqliteTable(
  "landscape_app_people",
  {
    connectionId: text("connection_id").notNull(),
    appId: text("app_id").notNull(),
    personId: text("person_id").notNull(),
    name: text(),
    scopes: text({ mode: "json" }).$type<string[]>().notNull(),
    firstSeen: timestamp("first_seen").notNull(),
    lastSeen: timestamp("last_seen").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.connectionId, table.appId, table.personId],
    }),
    index("landscape_app_people_last_seen_idx").on(table.lastSeen),
  ]
);

/**
 * The apps a landscape sync under way has read so far (src/landscape.ts):
 * kept apart, by the sync's start, and published to `landscape_apps` all
 * at once only when the sync has read everything, so a sync that stops
 * part way changes nothing anyone sees.
 */
export const landscapeStagedApps = sqliteTable(
  "landscape_staged_apps",
  {
    connectionId: text("connection_id").notNull(),
    startedAt: timestamp("started_at").notNull(),
    appId: text("app_id").notNull(),
    name: text().notNull(),
    publisher: text(),
    unverifiedPublisher: text("unverified_publisher"),
    verified: integer({ mode: "boolean" }).notNull(),
    adminScopes: text("admin_scopes", { mode: "json" }).$type<string[]>(),
  },
  (table) => [
    primaryKey({
      columns: [table.connectionId, table.startedAt, table.appId],
    }),
  ]
);

/** The people a landscape sync under way has read so far, published with its apps. */
export const landscapeStagedPeople = sqliteTable(
  "landscape_staged_people",
  {
    connectionId: text("connection_id").notNull(),
    startedAt: timestamp("started_at").notNull(),
    appId: text("app_id").notNull(),
    personId: text("person_id").notNull(),
    name: text(),
    scopes: text({ mode: "json" }).$type<string[]>().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.connectionId,
        table.startedAt,
        table.appId,
        table.personId,
      ],
    }),
  ]
);
