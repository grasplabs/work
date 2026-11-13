import { collections } from "@grasp-os/brain/schema";
import { appErrors } from "@grasp-os/shared/apps";
import type {
  AuditActor,
  AuditDetailValue,
  AuditEntry,
} from "@grasp-os/shared/audit";
import { actorOf, createAuditEvent } from "@grasp-os/shared/audit";
import { connectorEventActions } from "@grasp-os/shared/connect";
import {
  appIdSchema,
  permissionIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import type { AppId, PermissionId, TriggerId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  declaredPermissionSchema,
  grantReviewSchema,
  permissionErrors,
  permissionObjectSchema,
  permissionRequestSchema,
  permissionStatusSchema,
  permissionSubjectSchema,
} from "@grasp-os/shared/permissions";
import type {
  Authority,
  DeclaredPermission,
  Permission,
  PermissionObject,
  PermissionStatus,
  PermissionSubject,
  PermissionSubjectType,
  WorkContext,
} from "@grasp-os/shared/permissions";
import {
  isMemberAdmin,
  requireAdmin,
  requireBuilder,
  roleErrors,
} from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { MemberRole } from "@grasp-os/shared/subject-members";
import {
  triggerEventsRequest,
  triggerStartRequest,
} from "@grasp-os/shared/workflow-triggers";
import {
  and,
  asc,
  eq,
  inArray,
  getTableColumns,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { tellKept } from "./access-revocations.ts";
import {
  auditedBatch,
  outboxedEventWhere,
  outboxedIfChanged,
  storedEvent,
} from "./audit-outbox.ts";
import { activeMember, organizationId } from "./auth/auth.ts";
import { memberRole } from "./auth/identity.ts";
import type { Acting } from "./auth/identity.ts";
import { storedTeamsOf, unreadableTeam } from "./brain-grant-teams.ts";
import { personOf, requireOfferedConnection } from "./connections.ts";
import { madeSensitiveByGrant, widenedByGrant } from "./data-policy.ts";
import type { Grantee } from "./data-policy.ts";
import {
  apps,
  appVersions,
  auditOutbox,
  permissions,
  triggerResources,
  triggerResourceVersions,
  workflowResources,
} from "./db/core/schema.ts";
import { isUniqueViolation } from "./db/d1.ts";
import { appHost, callObject, workspace } from "./durable-objects.ts";

// Permission records and the one check every server path runs. A person
// asks for a permission (it allows nothing yet), an admin grants it, their
// own request included, and an admin can revoke it at any time. Grasp
// staff do neither: a client's permissions are the client's to decide.
// Checks read the records on every call, so a revoke applies to the next
// call. Every change is audited with who made it and the permission's
// subject, object, actions and binding.
//
// Granting is one conditional update, from requested to active, in the
// same batch as its audit event.
//
// A connection the chat's agent asks for in a chat holds in that chat
// alone (chat-connections.ts): its person grants their own personal
// connection there, an admin a shared one, and every read and check here
// leaves it out anywhere else (`holdsIn`).

type Row = typeof permissions.$inferSelect;

const stringListSchema = z.array(z.string());

/** How a subject is stored: its type, and its ID by that type. */
const subjectColumns = (
  subject: PermissionSubject
): { subjectType: PermissionSubjectType; subjectId: string } => {
  switch (subject.type) {
    case "app": {
      return { subjectType: subject.type, subjectId: subject.appId };
    }
    case "agent": {
      return { subjectType: subject.type, subjectId: subject.agentId };
    }
    case "workflow": {
      return { subjectType: subject.type, subjectId: subject.workflowId };
    }
    case "trigger": {
      return { subjectType: subject.type, subjectId: subject.triggerId };
    }
    default: {
      return subject satisfies never;
    }
  }
};

/** The key of a stored subject's ID, by its type. */
const subjectIdKeys = {
  app: "appId",
  agent: "agentId",
  workflow: "workflowId",
  trigger: "triggerId",
} as const satisfies Record<PermissionSubjectType, string>;

/** How an object is stored (see the `permissions` table). */
const objectColumns = (object: PermissionObject) => {
  switch (object.type) {
    case "connection": {
      return {
        objectType: object.type,
        objectId: object.connectionId,
        resource: object.resource ?? null,
        teams: null,
      };
    }
    case "collection": {
      return {
        objectType: object.type,
        objectId: object.collectionId,
        resource: null,
        teams: null,
      };
    }
    case "workflow": {
      return {
        objectType: object.type,
        objectId: object.workflowId,
        resource: null,
        teams: null,
      };
    }
    case "app": {
      // One of its functions, for a workflow's grant: by its stable ID.
      return {
        objectType: object.type,
        objectId: object.appId,
        resource: object.function ?? null,
        teams: null,
      };
    }
    case "platform": {
      // One platform: the ID only fills the column.
      return {
        objectType: object.type,
        objectId: "platform",
        resource: null,
        teams: object.teams === undefined ? null : JSON.stringify(object.teams),
      };
    }
    default: {
      return object satisfies never;
    }
  }
};

/** A stored object back in its API shape; anything unexpected fails. */
const objectOf = (row: Row): PermissionObject => {
  const resource = row.resource ?? undefined;
  switch (row.objectType) {
    case "connection": {
      return permissionObjectSchema.parse({
        type: row.objectType,
        connectionId: row.objectId,
        ...(resource === undefined ? {} : { resource }),
      });
    }
    case "collection": {
      return permissionObjectSchema.parse({
        type: row.objectType,
        collectionId: row.objectId,
      });
    }
    case "workflow": {
      return permissionObjectSchema.parse({
        type: row.objectType,
        workflowId: row.objectId,
      });
    }
    case "app": {
      return permissionObjectSchema.parse({
        type: row.objectType,
        appId: row.objectId,
        ...(resource === undefined ? {} : { function: resource }),
      });
    }
    case "platform": {
      return permissionObjectSchema.parse({
        type: row.objectType,
        // A malformed value as the team nobody is in: shown and checked
        // closed, and no one else's listing breaks on it.
        ...(row.teams === null
          ? {}
          : { teams: storedTeamsOf(row.teams) ?? [unreadableTeam] }),
      });
    }
    default: {
      throw new Error(`Unknown permission object ${String(row.objectType)}`);
    }
  }
};

const subjectOf = (row: Row): PermissionSubject =>
  permissionSubjectSchema.parse({
    type: row.subjectType,
    [subjectIdKeys[row.subjectType]]: row.subjectId,
  });

export const toPermission = (row: Row): Permission => ({
  id: permissionIdSchema.parse(row.id),
  subject: subjectOf(row),
  object: objectOf(row),
  actions: stringListSchema.parse(JSON.parse(row.actions)),
  binding: row.binding,
  status: row.status,
  requestedBy: row.requestedBy,
  requestedAt: row.requestedAt.toISOString(),
  grantedBy: row.grantedBy,
  grantedAt: row.grantedAt?.toISOString() ?? null,
  revokedBy: row.revokedBy,
  revokedAt: row.revokedAt?.toISOString() ?? null,
  requestedVia: row.requestedVia ?? null,
  chat: row.chatId,
});

/** Where a check runs: the context, and the person it acts for. */
export interface Where {
  context?: WorkContext;
  onBehalfOf?: string;
}

/**
 * The permissions that hold `where`, as SQL: those that hold wherever
 * their subject works, and, in a chat, those of that chat alone
 * (chat-connections.ts), for the person who asked for them there.
 * Anywhere else, or with no chat and person, a chat's permission holds
 * nowhere: it fails closed.
 */
const holdsIn = ({ context, onBehalfOf }: Where = {}): SQL =>
  context?.type === "chat" && onBehalfOf !== undefined
    ? sql`(${permissions.chatId} IS NULL OR (${permissions.chatId} = ${context.chatId} AND ${permissions.requestedBy} = ${onBehalfOf}))`
    : isNull(permissions.chatId);

/**
 * That no other live permission of the same subject has this row's
 * binding the other way round, as SQL on the row being granted: one of a
 * chat's against one that holds everywhere, and back. One name is one
 * stub in an env: a later grant must never take over a name a chat's
 * code already calls (the unique indexes cover each side on its own).
 */
export const noBindingClash = sql`NOT EXISTS (SELECT 1 FROM "permissions" AS "other" WHERE "other"."subject_type" = "permissions"."subject_type" AND "other"."subject_id" = "permissions"."subject_id" AND "other"."binding" = "permissions"."binding" AND "other"."status" <> 'revoked' AND ("other"."chat_id" IS NULL) <> ("permissions"."chat_id" IS NULL))`;

/**
 * Refuses a grant of `row` (with `permission.conflict`) while
 * `noBindingClash` doesn't hold for it; the grant's own update checks it
 * again, for a clash that lands in between.
 */
export const requireNoBindingClash = async (
  env: Env,
  row: Pick<Row, "id" | "binding">
): Promise<void> => {
  const clash = await drizzle(env.DB)
    .select({ id: permissions.id })
    .from(permissions)
    .where(and(eq(permissions.id, row.id), sql`NOT ${noBindingClash}`))
    .get();
  if (clash !== undefined) {
    throw permissionErrors.create("permission.conflict", {
      binding: row.binding,
    });
  }
};

/** Rows of `subject`, as a condition. */
const ofSubject = (subject: PermissionSubject): SQL | undefined => {
  const { subjectType, subjectId } = subjectColumns(subject);
  return and(
    eq(permissions.subjectType, subjectType),
    eq(permissions.subjectId, subjectId)
  );
};

/** What the audit log records of a permission: identifiers only. */
const auditDetail = ({
  subject,
  object,
  actions,
  binding,
  chat,
}: Permission): Record<string, AuditDetailValue> => {
  // The object's IDs by name: connectionId and resource, collectionId,
  // workflowId, or appId. A Brain permission's teams aren't counted: the
  // permission the event names holds them, and a count read by SQL (a
  // revocation's event) couldn't check them as `storedTeamsOf` does.
  const { type: objectType, ...ids } =
    object.type === "platform" ? { type: object.type } : object;
  const { subjectType, subjectId } = subjectColumns(subject);
  return {
    subjectType,
    subjectId,
    objectType,
    ...ids,
    actions: actions.join(" "),
    binding,
    // A chat's own permission: which chat, as its person's other events
    // name it.
    ...(chat === null ? {} : { chat }),
  };
};

export type PermissionAction =
  `permission.${"requested" | "granted" | "request_denied" | "revoked"}`;

/**
 * The audit entry of a change to `permission` by `actor`, with `extra`
 * detail such as who asked for it.
 */
export const permissionEntry = (
  actor: AuditActor,
  action: PermissionAction,
  permission: Permission,
  extra: Record<string, AuditDetailValue> = {}
): AuditEntry => ({
  actor,
  action,
  target: { type: "permission", id: permission.id },
  detail: { ...auditDetail(permission), ...extra },
});

/**
 * The audit entry of a change to `permission` by `by`: a person, or the
 * chat's agent acting for them.
 */
export const changeEntry = (
  by: Pick<Acting, "userId" | "staff" | "actor">,
  action: PermissionAction,
  permission: Permission,
  extra: Record<string, AuditDetailValue> = {}
): AuditEntry =>
  permissionEntry(by.actor ?? actorOf(by), action, permission, extra);

/**
 * Refuses anyone but one of the organization's own admins: who may grant
 * and revoke. Grasp staff are admins, but never decide a client's
 * permissions.
 */
export const requireMemberAdmin = (by: Identity): void => {
  requireAdmin(by);
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
};

/**
 * That `by` is still an active admin of the organization, as SQL: part of
 * the very update that grants or revokes, so an admin demoted or removed
 * after their session was checked changes nothing.
 */
export const stillAdminSql = (by: Identity): SQL =>
  activeMember(by.userId, ["admin"]);

/**
 * After a grant or revoke changed nothing: refuses with `role.forbidden`
 * if that was because `by` is no longer an active admin.
 */
export const requireStillAdmin = async (
  env: Env,
  by: Identity
): Promise<void> => {
  const row = await drizzle(env.DB).get<{ admin: number }>(
    sql`SELECT ${stillAdminSql(by)} AS admin`
  );
  if (row.admin === 0) {
    throw roleErrors.create("role.forbidden");
  }
};

const parseId = (id: unknown): PermissionId => {
  const parsed = permissionIdSchema.safeParse(id);
  if (!parsed.success) {
    throw permissionErrors.create("permission.not_found");
  }
  return parsed.data;
};

/**
 * Tells App `subject`'s pages that what it may start changed, after a
 * grant or revoke of one of its permissions, so their live workflow
 * queries read again (page-workflows.ts). Best effort: the change
 * stands if the App's host can't be reached.
 */
const tellPolicyChanged = async (
  env: Env,
  subject: PermissionSubject
): Promise<void> => {
  if (subject.type !== "app") {
    return;
  }
  try {
    await appHost(env, subject.appId).workflowPolicyChanged();
  } catch (error) {
    log.error("app.workflow_policy_tell_failed", {
      appId: subject.appId,
      ...errorFields(error),
    });
  }
};

/**
 * That a permission row is of a kind the platform serves, as SQL: not a
 * store's own grant nor a grant on a store. Those are left from before each
 * App's store was its own; nothing serves them, so every read takes them
 * as not there, and a later release removes them with their audit events.
 */
const servedSql = sql`${permissions.subjectType} <> 'store' AND ${permissions.objectType} <> 'store'`;

export const findRow = async (env: Env, id: string): Promise<Row | undefined> =>
  await drizzle(env.DB)
    .select()
    .from(permissions)
    .where(and(eq(permissions.id, id), servedSql))
    .get();

/**
 * The Apps a permission names, its subject and the App an agent calls,
 * must be in the registry: one query for both. Apps are never deleted, so
 * one that exists now still does when the permission is stored.
 */
const requireApps = async (
  env: Env,
  subject: PermissionSubject,
  object: PermissionObject
): Promise<void> => {
  const named = new Map<string, string>();
  if (subject.type === "app") {
    named.set("subject.appId", subject.appId);
  }
  if (object.type === "app") {
    named.set("object.appId", object.appId);
  }
  if (named.size === 0) {
    return;
  }
  const found = await drizzle(env.DB)
    .select({ id: apps.id })
    .from(apps)
    .where(inArray(apps.id, [...new Set(named.values())]));
  const existing = new Set(found.map(({ id }) => id));
  const missing = [...named].filter(([, appId]) => !existing.has(appId));
  if (missing.length > 0) {
    throw permissionErrors.create("permission.invalid", {
      issues: missing.map(([path]) => `${path}: There's no such App.`),
    });
  }
};

/**
 * A collection a permission names must exist, and not be someone's
 * personal collection: Apps and agents never read those (see
 * knowledge/access.ts), so nobody can be asked to grant one.
 *
 * Nor is an App given the Apps collection (knowledge/apps-collection.ts).
 * It is open to everyone as a collection, but Knowledge shows each entry
 * only to whoever may open its App, and provenance (app-provenance.ts)
 * judges a collection by the collection's access alone. So an App that
 * read it could hold another App's AGENTS.md, and be shared with someone
 * who may not open that App, and both provenance checks would pass. An
 * agent acts for its person, who may read what they find there, and keeps
 * nothing to share: it may be given it, to read. Nobody writes it (its
 * entries are made from the Apps themselves), and an agent builds Apps
 * as its person with no permission of its own (agent-builds.ts), so a
 * `write` on it would allow nothing: it is refused rather than granted.
 */
const requireCollection = async (
  env: Env,
  subject: PermissionSubject,
  object: PermissionObject,
  actions: readonly string[]
): Promise<void> => {
  if (object.type !== "collection") {
    return;
  }
  const found = await drizzle(env.KNOWLEDGE)
    .select({ access: collections.access, source: collections.source })
    .from(collections)
    .where(eq(collections.id, object.collectionId))
    .get();
  if (!found) {
    throw permissionErrors.create("permission.invalid", {
      issues: ["object.collectionId: There's no such collection."],
    });
  }
  if (found.access === "me") {
    throw permissionErrors.create("permission.invalid", {
      issues: [
        "object.collectionId: A personal collection can't be given to an App or agent.",
      ],
    });
  }
  if (found.access === "admins") {
    throw permissionErrors.create("permission.invalid", {
      issues: [
        "object.collectionId: A collection for admins can't be given to an App or agent.",
      ],
    });
  }
  // Code that keeps what it reads (an App, an independent workflow or
  // trigger) never gets it: only an agent, acting for its person.
  if (found.source === "apps" && subject.type !== "agent") {
    throw permissionErrors.create("permission.invalid", {
      issues: [
        "object.collectionId: The Apps collection is given to agents alone.",
      ],
    });
  }
  if (found.source === "apps" && actions.some((action) => action !== "read")) {
    throw permissionErrors.create("permission.invalid", {
      issues: [
        "actions: The Apps collection is only read. Building Apps needs no permission of the agent's own.",
      ],
    });
  }
};

/**
 * Who may name what in a permission, handed in by the caller: an App's
 * roles (`appFor` in apps.ts) and an independent resource's
 * (`requireResourceRole` in permission-resources.ts), passed in because
 * those modules depend on this one. Each refuses as for a resource that
 * doesn't exist.
 */
export interface PermissionRoles {
  app: (app: AppId, role: MemberRole) => Promise<unknown>;
  resource: (
    ref: { type: "workflow" | "trigger"; id: string },
    needed: "user" | "builder"
  ) => Promise<unknown>;
}

/**
 * Refuses `by` unless they build `subject`: an App's builders, a
 * workflow's builders, a trigger's manager (`roles`).
 * An agent is the organization's own: any builder asks for it.
 */
const requireSubjectBuilder = async (
  subject: PermissionSubject,
  roles: PermissionRoles
): Promise<void> => {
  switch (subject.type) {
    case "app": {
      await roles.app(subject.appId, "builder");
      break;
    }
    case "agent": {
      break;
    }
    case "workflow": {
      await roles.resource(
        { type: "workflow", id: subject.workflowId },
        "builder"
      );
      break;
    }
    case "trigger": {
      await roles.resource(
        { type: "trigger", id: subject.triggerId },
        "builder"
      );
      break;
    }
    default: {
      subject satisfies never;
    }
  }
};

/** Refuses a request with `issue`. */
const refuseRequest = (issue: string): never => {
  throw permissionErrors.create("permission.invalid", { issues: [issue] });
};

/**
 * Moves workflow `id`'s policy generation on, for the batch of a grant or
 * revocation on it, only when `landed` says the batch changed it: who may
 * start or follow it changed, so a start decided before is refused
 * (workflow-starts.ts). One that changed nothing refuses nothing.
 */
const workflowGenerationMoved = (
  db: ReturnType<typeof drizzle>,
  id: string,
  landed: SQL
) =>
  db
    .update(workflowResources)
    .set({ policyGeneration: sql`${workflowResources.policyGeneration} + 1` })
    .where(and(eq(workflowResources.id, id), landed));

/**
 * Refuses `send` on a workflow for anyone but an App: events reach a run
 * only through an App's page or mutation, so no other subject is
 * granted what it can't use.
 */
const requireSenderFits = (
  subject: PermissionSubject,
  object: PermissionObject,
  actions: readonly string[]
): void => {
  if (
    object.type === "workflow" &&
    subject.type !== "app" &&
    actions.includes("send")
  ) {
    refuseRequest("actions: Only an App sends events to a workflow's runs.");
  }
};

/**
 * Refuses an `app` permission but an agent's on a whole App and an
 * independent workflow's on one of its functions (by its stable ID):
 * Apps don't call each other, an agent acts for its person in every App
 * they use, and a workflow reaches only the functions it was granted,
 * each on its own.
 */
const requireAppCallerFits = (
  subject: PermissionSubject,
  object: PermissionObject
): void => {
  if (object.type !== "app") {
    return;
  }
  if (subject.type === "agent" && object.function !== undefined) {
    refuseRequest(
      "object.function: An agent calls an App's public functions, not one of them."
    );
  }
  if (subject.type === "workflow" && object.function === undefined) {
    refuseRequest(
      "object.function: A workflow calls one of an App's functions, by the ID the App's definition gives it."
    );
  }
  if (subject.type !== "agent" && subject.type !== "workflow") {
    refuseRequest(
      "subject: Only an agent or a workflow calls an App's functions through a permission."
    );
  }
};

/**
 * Refuses an object `subject` has no use for: what the platform offers is
 * for an App's code; a trigger only starts, so it holds `start` on a
 * workflow, and a connector trigger its event's read on its connection,
 * and nothing else; only an App sends a workflow's runs events. Only an
 * agent writes a collection: an App and a workflow only read one (their
 * collection stubs have no write), and keep what they write elsewhere, so
 * `write` would give them nothing an admin could see being granted.
 */
const requireObjectFits = (
  subject: PermissionSubject,
  object: PermissionObject,
  actions: readonly string[]
): void => {
  // The Brain is the one platform offer an agent or an independent
  // workflow may hold too: Apps, runs and agents share its permission.
  const brainReader =
    actions.includes("brain") &&
    (subject.type === "agent" || subject.type === "workflow");
  if (object.type === "platform" && subject.type !== "app" && !brainReader) {
    refuseRequest("subject: Only an App uses what the platform offers.");
  }
  // Teams only for an App: what it recalls of a team is checked against
  // whoever it is shared with (app-provenance.ts); nothing checks a
  // workflow's runs or an agent's chats so.
  if (
    object.type === "platform" &&
    object.teams !== undefined &&
    subject.type !== "app"
  ) {
    refuseRequest(
      "object: Only an App's permission to read the Brain names teams."
    );
  }
  requireAppCallerFits(subject, object);
  // A connector trigger also hears its connection's events: which, the
  // one its version names, is `requireTriggerPins`'s to check.
  if (
    subject.type === "trigger" &&
    object.type !== "connection" &&
    (object.type !== "workflow" ||
      !actions.every((action) => action === "start"))
  ) {
    refuseRequest(
      "object: A trigger only starts a workflow, or hears its connection's events."
    );
  }
  requireSenderFits(subject, object, actions);
  if (
    object.type === "collection" &&
    subject.type !== "agent" &&
    actions.includes("write")
  ) {
    refuseRequest(
      "actions: Only an agent writes a collection. An App or a workflow reads it, and keeps what it writes elsewhere."
    );
  }
};

/**
 * Refuses a connector trigger's grant on a connection but exactly the
 * connection and part its current version names, for its event's read
 * action alone.
 */
const requireTriggerHears = async (
  env: Env,
  triggerId: string,
  object: Extract<PermissionObject, { type: "connection" }>,
  actions: readonly string[]
): Promise<void> => {
  const heard = await drizzle(env.DB)
    .select({
      connectionId: triggerResourceVersions.connectionId,
      resource: triggerResourceVersions.connectionResource,
      eventType: triggerResourceVersions.eventType,
    })
    .from(triggerResources)
    .innerJoin(
      triggerResourceVersions,
      and(
        eq(triggerResourceVersions.triggerId, triggerResources.id),
        eq(triggerResourceVersions.version, triggerResources.currentVersion)
      )
    )
    .where(
      and(
        eq(triggerResources.id, triggerId),
        eq(triggerResources.kind, "connector"),
        isNull(triggerResources.deletedAt)
      )
    )
    .get();
  const action = Object.entries(connectorEventActions).find(
    ([type]) => type === heard?.eventType
  )?.[1];
  if (
    heard === undefined ||
    heard.connectionId !== object.connectionId ||
    heard.resource !== (object.resource ?? null) ||
    action === undefined ||
    actions.length !== 1 ||
    actions[0] !== action
  ) {
    refuseRequest(
      "object: A trigger's grant on a connection names its connection, and the read its event needs."
    );
  }
};

/**
 * Refuses a trigger's grant on any workflow but the one the trigger's
 * current version starts: a trigger starts one workflow, and its grant
 * names it; on a connection, any but the one it hears
 * (`requireTriggerHears`). A trigger that isn't live names none.
 */
const requireTriggerPins = async (
  env: Env,
  subject: PermissionSubject,
  object: PermissionObject,
  actions: readonly string[]
): Promise<void> => {
  if (subject.type !== "trigger") {
    return;
  }
  if (object.type === "connection") {
    await requireTriggerHears(env, subject.triggerId, object, actions);
    return;
  }
  if (object.type !== "workflow") {
    return;
  }
  const pinned = await drizzle(env.DB)
    .select({ workflowId: triggerResourceVersions.workflowResourceId })
    .from(triggerResources)
    .innerJoin(
      triggerResourceVersions,
      and(
        eq(triggerResourceVersions.triggerId, triggerResources.id),
        eq(triggerResourceVersions.version, triggerResources.currentVersion)
      )
    )
    .where(
      and(
        eq(triggerResources.id, subject.triggerId),
        isNull(triggerResources.deletedAt)
      )
    )
    .get();
  if (pinned?.workflowId !== object.workflowId) {
    refuseRequest("object: A trigger's grant names the workflow it starts.");
  }
};

/**
 * Inserts `row` only while `condition` holds as the statement runs: one
 * statement, so nothing lands between the check and the insert. Each
 * column's value as the table stores it, in the order an insert from a
 * select names them (every column, as defined). `outboxedIfChanged`
 * after it records it only if it landed.
 */
export const insertWhere = (
  db: ReturnType<typeof drizzle>,
  row: Row,
  condition: SQL
) => {
  const values = Object.entries(getTableColumns(permissions)).map(
    ([key, column]) => {
      const value: unknown = Reflect.get(row, key);
      return value === null
        ? sql`NULL`
        : sql`${column.mapToDriverValue(value)}`;
    }
  );
  return db
    .insert(permissions)
    .select(sql`SELECT ${sql.join(values, sql`, `)} WHERE ${condition}`);
};

/** A stored JSON list of strings, joined by spaces, as SQL. */
const joined = (list: typeof permissions.actions): SQL =>
  sql`(SELECT group_concat(value, ' ') FROM json_each(${list}))`;

/**
 * The ID of the audit event one statement stores for the permission row,
 * as SQL: a random UUID (`fresh`, one per statement) whose last part is
 * the permission's own ID's, so each row's event has its own ID, and every
 * statement's are new. A UUID still: the version and variant are `fresh`'s,
 * and a permission's ID is a UUID too.
 */
const eventIdSql = (fresh: string): SQL =>
  sql`${fresh.slice(0, 24)} || lower(substr(${permissions.id}, 25, 12))`;

/**
 * What `auditDetail` records of a permission row, as SQL: its IDs by name
 * (connectionId and resource; collectionId; workflowId; appId), its
 * actions and its binding.
 */
const auditDetailSql = sql`json_patch(
  json_object('subjectType', ${permissions.subjectType}, 'subjectId', ${permissions.subjectId}, 'objectType', ${permissions.objectType}),
  CASE ${permissions.objectType}
    WHEN 'connection' THEN json_patch(
      json_object('connectionId', ${permissions.objectId}),
      CASE WHEN ${permissions.resource} IS NULL THEN '{}' ELSE json_object('resource', ${permissions.resource}) END
    )
    WHEN 'collection' THEN json_object('collectionId', ${permissions.objectId})
    WHEN 'app' THEN json_patch(
      json_object('appId', ${permissions.objectId}),
      CASE WHEN ${permissions.resource} IS NULL THEN '{}' ELSE json_object('function', ${permissions.resource}) END
    )
    WHEN 'workflow' THEN json_object('workflowId', ${permissions.objectId})
    ELSE '{}'
  END
)`;

/**
 * The statements revoking, for `by`, every permission row `held` finds,
 * each audited as `permission.revoked` (with `reason` in its detail, when
 * given), from the rows the batch itself finds, so none is revoked
 * unaudited, whenever it landed.
 */
const revokedWhere = (
  db: DrizzleD1Database,
  by: Acting,
  held: SQL | undefined,
  reason?: string
): [BatchItem<"sqlite">, BatchItem<"sqlite">] => {
  const now = new Date();
  const eventId = eventIdSql(crypto.randomUUID());
  const event = sql`json_object(
    'id', ${eventId},
    'at', ${now.toISOString()},
    'source', 'core',
    'actor', json(${JSON.stringify(by.actor ?? actorOf(by))}),
    'action', 'permission.revoked',
    'target', json_object('type', 'permission', 'id', ${permissions.id}),
    'provenance', json('[]'),
    'detail', json_set(
      ${auditDetailSql},
      '$.actions', ${joined(permissions.actions)},
      '$.binding', ${permissions.binding}${
        reason === undefined ? sql`` : sql`, '$.reason', ${reason}`
      }
    )
  )`;
  return [
    db
      .insert(auditOutbox)
      .select(
        sql`SELECT ${eventId}, ${event}, ${now.getTime()} FROM ${permissions} WHERE ${held}`
      ),
    db
      .update(permissions)
      .set({ status: "revoked", revokedBy: by.userId, revokedAt: now })
      .where(held),
  ];
};

/**
 * The statements revoking, for `by`, every permission of `subject` that
 * isn't revoked yet, for the batch that removes `subject` (a trigger
 * deleted), each audited (`revokedWhere`).
 */
export const revokedWith = (
  db: DrizzleD1Database,
  by: Acting,
  subject: PermissionSubject
): [BatchItem<"sqlite">, BatchItem<"sqlite">] =>
  revokedWhere(
    db,
    by,
    and(ofSubject(subject), ne(permissions.status, "revoked"))
  );

/**
 * The statements revoking, for `by`, `subject`'s grants on a store that
 * still hold binding name `binding`, each audited with the reason: left
 * from before each App's store was its own, they serve nothing and every
 * read takes them as not there (`servedSql`), yet the name stays taken
 * among the subject's live permissions. So a request under that name
 * frees it in its own batch. A later release removes the rest.
 */
const leftoverStoreGrantsRevoked = (
  db: DrizzleD1Database,
  by: Acting,
  subject: PermissionSubject,
  binding: string
): [BatchItem<"sqlite">, BatchItem<"sqlite">] =>
  revokedWhere(
    db,
    by,
    and(
      ofSubject(subject),
      eq(permissions.binding, binding),
      sql`${permissions.objectType} = 'store'`,
      ne(permissions.status, "revoked"),
      isNull(permissions.chatId)
    ),
    "binding kind removed"
  );

/**
 * That `userId` is in each of `teams` now, a team of this organization,
 * as SQL: what a request naming teams (an App's grant to read the Brain)
 * needs, so a requester names only teams whose content they may read,
 * and an ID that is no team, or another company's, is refused the same.
 * One bound list, whatever the number of teams.
 */
const inEveryTeamSql = (userId: string, teams: readonly string[]): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM json_each(${JSON.stringify(teams)}) AS named
    WHERE NOT EXISTS (SELECT 1 FROM team_members AS held
      JOIN teams AS team ON team.id = held.team_id
      WHERE held.team_id = named.value AND held.user_id = ${userId}
        AND team.organization_id = ${organizationId}))`;

/**
 * That App `app` has a grant to read the Brain naming teams, asked for or
 * ever granted, as SQL (GRA-1842). Its data may hold a team's content,
 * which nothing checks once a workflow's run holds it, so no workflow
 * calls it until GRA-1843 rules what runs may carry.
 */
export const teamBrainOfAppSql = (app: SQLWrapper | string): SQL =>
  sql`EXISTS (SELECT 1 FROM permissions AS brain
    WHERE brain.subject_type = 'app' AND brain.subject_id = ${app}
      AND brain.object_type = 'platform' AND brain.teams IS NOT NULL
      AND (brain.status <> 'revoked' OR brain.granted_at IS NOT NULL))`;

/** That a workflow may call one of App `app`'s functions, asked for or granted, as SQL. */
const workflowCallsAppSql = (app: string): SQL =>
  sql`EXISTS (SELECT 1 FROM permissions AS caller
    WHERE caller.subject_type = 'workflow' AND caller.object_type = 'app'
      AND caller.object_id = ${app} AND caller.resource IS NOT NULL
      AND caller.status <> 'revoked')`;

/**
 * What a request must hold as it is written, each with the refusal that
 * says it doesn't (GRA-1842): a request naming teams only by someone in
 * all of them, and only for an App no workflow may call; a workflow's
 * grant to call an App's function only on an App whose Brain grant names
 * no team.
 */
const teamGuardsOf = (
  by: Acting,
  subject: PermissionSubject,
  object: PermissionObject
): { holds: SQL; refusal: () => Error }[] => {
  if (
    object.type === "platform" &&
    object.teams !== undefined &&
    subject.type === "app"
  ) {
    return [
      {
        holds: inEveryTeamSql(by.userId, object.teams),
        refusal: () =>
          permissionErrors.create("permission.invalid", {
            issues: ["object: Name only teams you are in."],
          }),
      },
      {
        holds: sql`NOT ${workflowCallsAppSql(subject.appId)}`,
        refusal: () =>
          permissionErrors.create("permission.team_brain_workflow"),
      },
    ];
  }
  if (
    subject.type === "workflow" &&
    object.type === "app" &&
    object.function !== undefined
  ) {
    return [
      {
        holds: sql`NOT ${teamBrainOfAppSql(object.appId)}`,
        refusal: () =>
          permissionErrors.create("permission.team_brain_workflow"),
      },
    ];
  }
  return [];
};

/**
 * Asks for a permission for an App, an agent, or an independent workflow
 * or trigger. It allows nothing until an admin grants it. Only the
 * subject's builders ask; a workflow only someone with a role in it names,
 * and an App an agent calls only someone with a role in that App
 * (`roles`), before anything says whether it exists.
 */
export const requestPermission = async (
  env: Env,
  by: Acting,
  input: unknown,
  roles: PermissionRoles,
  /** Admits the write, called right before it is committed: throws to refuse it. */
  admit?: () => Promise<void>
): Promise<Permission> => {
  requireBuilder(by);
  if (by.staff) {
    // Grasp staff neither ask for nor decide a client's permissions.
    throw roleErrors.create("role.forbidden");
  }
  const { subject, object, actions, binding } = permissionErrors.parse(
    "permission.invalid",
    permissionRequestSchema,
    input
  );
  await requireSubjectBuilder(subject, roles);
  requireObjectFits(subject, object, actions);
  await requireTriggerPins(env, subject, object, actions);
  if (object.type === "workflow") {
    // Only someone with a role in the workflow names it: anyone else is
    // told it doesn't exist, as for one that doesn't.
    await roles.resource({ type: "workflow", id: object.workflowId }, "user");
  }
  if (object.type === "app") {
    // Only someone with a role in the App names it (`roles`).
    await roles.app(object.appId, "user");
  }
  await requireApps(env, subject, object);
  if (object.type === "app" && object.function !== undefined) {
    // Imported here, not at the top: the App registry reaches back into
    // this module.
    const { requireAppFunction } = await import("./app-function-bindings.ts");
    await requireAppFunction(env, object.appId, object.function);
  }
  await requireCollection(env, subject, object, actions);
  const row: Row = {
    id: crypto.randomUUID(),
    ...subjectColumns(subject),
    ...objectColumns(object),
    actions: JSON.stringify(actions),
    binding,
    status: "requested",
    requestedBy: by.userId,
    requestedAt: new Date(),
    grantedBy: null,
    grantedAt: null,
    revokedBy: null,
    revokedAt: null,
    requestedVia: by.via ?? null,
    personal: false,
    chatId: null,
    reason: null,
  };
  const permission = toPermission(row);
  const db = drizzle(env.DB);
  // Held in the insert itself, so a membership or a grant landing
  // meanwhile is decided with it.
  const guards = teamGuardsOf(by, subject, object);
  // Not under a name one of a chat's own permissions has
  // (`noBindingClash`), in the insert itself: the unique indexes each
  // cover one side only.
  const { subjectType, subjectId } = subjectColumns(subject);
  // A trigger's only while it is live, in the insert too: one deleted
  // since it was read (`requireTriggerPins`) revoked its permissions, and
  // takes no request after.
  const live =
    subject.type === "trigger"
      ? sql` AND EXISTS (SELECT 1 FROM ${triggerResources} WHERE ${triggerResources.id} = ${subjectId} AND ${triggerResources.deletedAt} IS NULL)`
      : sql``;
  try {
    // Admitted last, with nothing slow left before the write.
    await admit?.();
    await auditedBatch(env, db, [
      ...leftoverStoreGrantsRevoked(db, by, subject, binding),
      insertWhere(
        db,
        row,
        sql`NOT EXISTS (SELECT 1 FROM ${permissions} WHERE subject_type = ${subjectType} AND subject_id = ${subjectId} AND binding = ${binding} AND chat_id IS NOT NULL AND status <> 'revoked')${live}${sql.join(
          guards.map(({ holds }) => sql` AND ${holds}`)
        )}`
      ),
      outboxedIfChanged(
        db,
        changeEntry(by, "permission.requested", permission)
      ),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw permissionErrors.create("permission.conflict", { binding });
    }
    throw error;
  }
  if ((await findRow(env, row.id)) === undefined) {
    // A trigger deleted meanwhile is refused as one gone is.
    await requireSubjectBuilder(subject, roles);
    // Which guard didn't hold, as read now: only which refusal to give.
    for (const { holds, refusal } of guards) {
      // oxlint-disable-next-line no-await-in-loop -- at most two, in order
      const held = await db.get<{ held: number }>(sql`SELECT ${holds} AS held`);
      if (held.held === 0) {
        throw refusal();
      }
    }
    throw permissionErrors.create("permission.conflict", { binding });
  }
  return permission;
};

/** `object` without a Brain grant's teams. */
const withoutTeams = (object: PermissionObject): PermissionObject => {
  if (object.type !== "platform") {
    return object;
  }
  const { teams: _teams, ...rest } = object;
  return rest;
};

/**
 * What a blueprint of App `app` declares as it is marked
 * (app-blueprints.ts), for each App created from it to ask for: of what
 * `app` asks for or was given (its permissions that aren't revoked), its
 * collections and what the platform offers, which name the same thing for
 * whoever creates from it. A connection is someone's, set up for this
 * App, and a workflow names an App, which the creator may not
 * see: a copy's builders ask for those themselves.
 */
export const declarableOf = async (
  env: Env,
  app: AppId
): Promise<DeclaredPermission[]> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(permissions)
    .where(
      and(
        ofSubject({ type: "app", appId: app }),
        inArray(permissions.status, ["requested", "active"]),
        inArray(permissions.objectType, ["collection", "platform"])
      )
    )
    .orderBy(asc(permissions.requestedAt), asc(permissions.id));
  // Refused, as a request would be, when one is no longer declarable (a
  // collection to write, which no App does): never an internal error.
  return rows.map((row) =>
    permissionErrors.parse("permission.invalid", declaredPermissionSchema, {
      // A Brain grant's teams are its requester's: a copy asks for the
      // company alone, and its builders name their own teams.
      object: withoutTeams(objectOf(row)),
      actions: stringListSchema.parse(JSON.parse(row.actions)),
      binding: row.binding,
    })
  );
};

/**
 * Requested rows of `subject` for `requested`, and their audit entries
 * (with `extra` in their detail), for the batch that creates `subject`.
 */
const requestsOf = (
  by: Acting,
  subject: PermissionSubject,
  requested: readonly {
    object: PermissionObject;
    actions: readonly string[];
    binding: string;
  }[],
  extra: Record<string, AuditDetailValue> = {}
): { rows: Row[]; entries: AuditEntry[] } => {
  const requestedAt = new Date();
  const rows = requested.map(({ object, actions, binding }): Row => ({
    id: crypto.randomUUID(),
    ...subjectColumns(subject),
    ...objectColumns(object),
    actions: JSON.stringify(actions),
    binding,
    status: "requested",
    requestedBy: by.userId,
    requestedAt,
    grantedBy: null,
    grantedAt: null,
    revokedBy: null,
    revokedAt: null,
    requestedVia: by.via ?? null,
    personal: false,
    chatId: null,
    reason: null,
  }));
  return {
    rows,
    entries: rows.map((row) =>
      changeEntry(by, "permission.requested", toPermission(row), extra)
    ),
  };
};

/**
 * Requests for `app`, made by `by` as `app` is created from the blueprint
 * `blueprint` (app-blueprints.ts), of what the blueprint declares: the
 * rows and their audit entries, for the batch that creates `app`. Like
 * any request, each allows nothing until an admin grants it.
 */
export const declaredRequests = (
  by: Acting,
  app: AppId,
  declared: readonly DeclaredPermission[],
  blueprint: string
): { rows: Row[]; entries: AuditEntry[] } => {
  // Checked again as each is asked for: a blueprint keeps what it declared
  // when it was marked, and what may be declared has narrowed since (a
  // collection only to read), so none is asked for that a request would be
  // refused.
  const checked = declared.map((permission) =>
    permissionErrors.parse(
      "permission.invalid",
      declaredPermissionSchema,
      permission
    )
  );
  return requestsOf(by, { type: "app", appId: app }, checked, { blueprint });
};

/**
 * Requests for `app`, made by `by` as `app` is created from the blueprint
 * `blueprint`, to start each workflow `started` names, the one the
 * creation made of each workflow the blueprint ships (app-blueprints.ts),
 * under its binding name: the rows and their audit entries, for the batch
 * that creates `app`. Like any request, each allows nothing until an
 * admin grants it.
 */
export const workflowStartRequests = (
  by: Acting,
  app: AppId,
  started: readonly { workflowId: string; binding: string }[],
  blueprint: string
): { rows: Row[]; entries: AuditEntry[] } =>
  requestsOf(
    by,
    { type: "app", appId: app },
    started.map(({ workflowId, binding }) =>
      permissionErrors.parse("permission.invalid", permissionRequestSchema, {
        subject: { type: "app", appId: app },
        object: { type: "workflow", workflowId },
        actions: ["start"],
        binding,
      })
    ),
    { blueprint }
  );

/**
 * The requests of trigger `trigger`, made by `by` as they create it
 * (trigger-resources.ts): to start workflow `workflowId`, the one it pins,
 * and, for a connector trigger, to hear its event on its connection
 * (`events`, as its version names them). The rows and their audit
 * entries, for the batch that creates the trigger, so no trigger is left
 * without a way to be allowed. Like any request, they allow nothing until
 * an admin grants them.
 */
export const triggerRequests = (
  by: Acting,
  trigger: TriggerId,
  workflowId: string,
  events?: {
    connection: { connectionId: string; resource?: string };
    event: string;
  }
): { rows: Row[]; entries: AuditEntry[] } => {
  const hears =
    events === undefined
      ? undefined
      : triggerEventsRequest(trigger, events.connection, events.event);
  return requestsOf(
    by,
    { type: "trigger", triggerId: trigger },
    [
      triggerStartRequest(trigger, workflowId),
      ...(hears === undefined ? [] : [hears]),
    ].map((request) =>
      permissionErrors.parse(
        "permission.invalid",
        permissionRequestSchema,
        request
      )
    )
  );
};

/**
 * Tells the chat's agent how its request for `permission` was decided,
 * for its next turn, and the chat's page that it no longer waits
 * (`Workspace.connectionDecided`). Only for a chat's own permission. A
 * failure is logged: the decision stands.
 */
export const tellChat = async (
  env: Env,
  permission: Permission,
  decision: "granted" | "denied"
): Promise<void> => {
  const { chat: chatId, requestedVia } = permission;
  if (chatId === null || requestedVia === null) {
    return;
  }
  try {
    const workspaceId = workspaceIdSchema.parse(requestedVia.workspaceId);
    // Again on a stub of its own should the object reset under the call: a
    // second notice of the same decision tells the agent nothing new.
    await callObject(async () => {
      await workspace(env, workspaceId).connectionDecided(
        chatId,
        permission.requestedBy,
        { binding: permission.binding, decision }
      );
    });
  } catch (error) {
    log.warn("chat.connection_decided_failed", {
      chatId,
      ...errorFields(error),
    });
  }
};

/** The App a workflow's request on one of its functions (`row`) names, if it is one. */
const functionAppOf = (row: Row): string | undefined =>
  row.objectType === "app" && row.resource !== null ? row.objectId : undefined;

/**
 * For a workflow's request on one of an App's functions (`row`), refuses
 * it unless the App's current version gives a query or mutation its ID
 * (app-function-bindings.ts): one removed since it was asked for is
 * granted to nobody. The grant then holds to that version as it lands
 * (`reviewedApp` in `grantPermission`).
 */
const requireServedFunction = async (env: Env, row: Row): Promise<void> => {
  const object = objectOf(row);
  if (object.type !== "app" || object.function === undefined) {
    return;
  }
  // Imported here, not at the top: the App registry reaches back into
  // this module.
  const { requireAppFunction } = await import("./app-function-bindings.ts");
  await requireAppFunction(env, object.appId, object.function);
};

/**
 * Grants a requested permission, the admin's own request included. Only
 * from requested: an active or revoked one is refused, so a revoke is for
 * good. Audited with who asked for it.
 *
 * `reviewed` names the version of the App the admin reviewed: the one
 * current as they decided (null for an agent's permission, or an App with
 * none current). The grant lands only while it still is, and approves it
 * (`madeCurrent`); otherwise it is refused with `app.conflict` and changes
 * nothing, so a builder can't swap the code while the admin looks.
 */
export const grantPermission = async (
  env: Env,
  by: Identity,
  id: unknown,
  reviewed: unknown
): Promise<Permission> => {
  requireMemberAdmin(by);
  const { version } = permissionErrors.parse(
    "permission.invalid",
    grantReviewSchema,
    reviewed
  );
  const found = await findRow(env, parseId(id));
  if (!found) {
    throw permissionErrors.create("permission.not_found");
  }
  // No grant ever names a missing or personal collection, nor gives an App
  // the Apps collection, nor anything but reading it, however old its
  // request.
  await requireCollection(
    env,
    subjectOf(found),
    objectOf(found),
    toPermission(found).actions
  );
  // A chat's own request: an admin grants only a shared connection, still
  // connected and offered. A personal one is its person's alone: to anyone
  // else it doesn't exist.
  if (found.personal) {
    throw permissionErrors.create("permission.not_found");
  }
  if (found.chatId !== null) {
    await requireOfferedConnection(
      env,
      await personOf(env, by),
      found.objectId
    );
  }
  await requireNoBindingClash(env, found);
  await requireServedFunction(env, found);
  const db = drizzle(env.DB);
  const event = createAuditEvent(
    changeEntry(by, "permission.granted", toPermission(found), {
      requestedBy: found.requestedBy,
    }),
    "core"
  );
  const isApp = found.subjectType === "app";
  // The App whose version the admin reviews: the App asking, or the App
  // whose function a workflow asks to call, whose current definition
  // named the function as they saw it (`Permission.functionName`).
  const reviewedApp = isApp ? found.subjectId : functionAppOf(found);
  if (reviewedApp === undefined && version !== null) {
    // An agent has no versions; an independent resource's versions are
    // immutable and pinned, so none is reviewed here.
    throw permissionErrors.create("permission.invalid", {
      issues: [
        "version: only an App's version is reviewed, or the version of the App whose function is called",
      ],
    });
  }
  // The version reviewed is still the one current (an agent has none).
  const stillReviewed =
    reviewedApp === undefined
      ? undefined
      : sql`(SELECT ${apps.currentVersion} FROM ${apps} WHERE ${apps.id} = ${reviewedApp}) IS ${version}`;
  let widened: Grantee | undefined;
  if (isApp) {
    widened = { type: "app", appId: appIdSchema.parse(found.subjectId) };
  } else if (found.subjectType === "workflow") {
    widened = { type: "workflow", workflowId: found.subjectId };
  }
  const [[granted], , madeSensitive] = await auditedBatch(env, db, [
    db
      .update(permissions)
      .set({ status: "active", grantedBy: by.userId, grantedAt: new Date() })
      .where(
        and(
          eq(permissions.id, found.id),
          eq(permissions.status, "requested"),
          stillAdminSql(by),
          stillReviewed,
          noBindingClash
        )
      )
      .returning(),
    outboxedEventWhere(db, event, sql`changes() > 0`),
    // The Apps whose data it makes sensitive again, read before that
    // happens below: their open connections are told to look again.
    madeSensitiveByGrant(db, widened, storedEvent(event.id)),
    // An admin granting an App's permission approves the version they
    // reviewed (`madeCurrent`), as they would by making it current.
    db
      .update(appVersions)
      .set({ approved: 1 })
      .where(
        and(
          eq(appVersions.appId, found.subjectId),
          eq(appVersions.version, version ?? 0),
          eq(appVersions.approved, 0),
          isApp ? storedEvent(event.id) : sql`0`,
          stillReviewed
        )
      ),
    // Who may start or follow a workflow changed: starts decided before
    // are refused (workflow-starts.ts).
    ...(found.objectType === "workflow"
      ? [workflowGenerationMoved(db, found.objectId, storedEvent(event.id))]
      : []),
    // More access for an App is more for every App that reaches it
    // through workflows: their data, if an admin had said it may go to
    // code Grasp didn't serve, is sensitive again, and their data policy
    // moves on (data-policy.ts). More for a workflow is
    // more for every App that starts it, or a workflow that binds it.
    ...(isApp
      ? widenedByGrant(
          db,
          by,
          { type: "app", appId: appIdSchema.parse(found.subjectId) },
          storedEvent(event.id),
          { permission: found.id }
        )
      : []),
    ...(found.subjectType === "workflow"
      ? widenedByGrant(
          db,
          by,
          { type: "workflow", workflowId: found.subjectId },
          storedEvent(event.id),
          { permission: found.id }
        )
      : []),
  ]);
  if (!granted) {
    await requireStillAdmin(env, by);
    await requireNoBindingClash(env, found);
    // Still requested: then the version reviewed is no longer current,
    // or no longer gives the function its ID.
    await requireServedFunction(env, found);
    const now = await findRow(env, found.id);
    if (now?.status === "requested") {
      throw appErrors.create("app.conflict");
    }
    throw permissionErrors.create("permission.not_requested");
  }
  await tellKept(env, madeSensitive);
  const permission = toPermission(granted);
  await tellPolicyChanged(env, permission.subject);
  await tellChat(env, permission, "granted");
  return permission;
};

/**
 * That `by` could grant a permission as the batch runs, as SQL: an admin
 * of the organization, not Grasp staff, still an admin then.
 */
const canGrantSql = (by: Identity): SQL =>
  isMemberAdmin(by) ? stillAdminSql(by) : sql`0`;

/**
 * That a permission lets an App change things for the person using it,
 * as SQL on its row: any on a connection (core can't tell a connector's
 * writes from its reads; connect knows), or with an action other than
 * `read`, such as starting a workflow, inviting guests, or an agent
 * calling an App's functions that write.
 */
const changesThingsSql = or(
  eq(permissions.objectType, "connection"),
  sql`EXISTS (SELECT 1 FROM json_each(${permissions.actions}) WHERE value NOT IN ('read', 'statistics'))`
);

/**
 * `changesThingsSql` for one action of a permission on `object`: reading
 * the platform's statistics (`statistics`) changes nothing either.
 */
const changesThings = (object: PermissionObject, action: string): boolean =>
  object.type === "connection" ||
  (action !== "read" && action !== "statistics");

/**
 * That `version` of `app` is one no admin approved (`madeCurrent`), as
 * SQL; each a value, or a column of the query it runs in. A version never
 * made current (null) is not one. The host always names a
 * version the App has; an independent workflow's start also requires the
 * version to exist (workflow-starts.ts).
 */
const unapprovedSql = (
  app: string | SQLWrapper,
  version: number | SQLWrapper
): SQL =>
  sql`EXISTS (SELECT 1 FROM ${appVersions} WHERE ${appVersions.appId} = ${app} AND ${appVersions.version} = ${version} AND ${appVersions.approved} = 0)`;

/**
 * The permissions that allow `action` on `object` for `subject`, as SQL
 * for a WHERE on `permissions`: the one rule every check goes by
 * (`authorize`, and connector events reaching Apps). Active, of that
 * subject, on that object (a permission for a whole connection covers each
 * resource in it; one for a resource only that resource), and listing the
 * action. For an App's code, an action that changes things (on a
 * connection, or other than `read`) also needs `appVersion`, the version
 * it runs, to be one an admin approved (`madeCurrent`): a run keeps the
 * version it started on, which may be one made current since without,
 * its permissions granted again for another. Without a version, which the
 * host always sets for an App, nothing is approved: it fails closed. The
 * App and its version may be columns of the query it runs in. `changes`
 * says whether the action changes things when the action alone doesn't.
 * A chat's own permission allows only in that chat, for the person who
 * asked for it there (`where`, `holdsIn`).
 */
export const allowingPermissionSql = (
  subject: PermissionSubject | { type: "app"; appId: SQLWrapper | AppId },
  appVersion: number | SQLWrapper | undefined,
  object: PermissionObject,
  action: string,
  changes = changesThings(object, action),
  where?: Where
): SQL => {
  const { objectType, objectId, resource } = objectColumns(object);
  let unapproved: SQL | undefined;
  if (subject.type === "app" && changes) {
    unapproved =
      appVersion === undefined
        ? sql`0`
        : sql`NOT ${unapprovedSql(subject.appId, appVersion)}`;
  }
  return (
    and(
      eq(permissions.subjectType, subject.type),
      eq(
        permissions.subjectId,
        subject.type === "app"
          ? subject.appId
          : subjectColumns(subject).subjectId
      ),
      eq(permissions.status, "active"),
      eq(permissions.objectType, objectType),
      eq(permissions.objectId, objectId),
      resource === null
        ? isNull(permissions.resource)
        : or(isNull(permissions.resource), eq(permissions.resource, resource)),
      sql`EXISTS (SELECT 1 FROM json_each(${permissions.actions}) WHERE value = ${action})`,
      unapproved,
      holdsIn(where)
    ) ?? sql`0`
  );
};

/** A version of an App becoming current (`madeCurrent`). */
export interface MadeCurrent {
  app: AppId;
  version: number;
  /** The version it replaces. */
  previous: number | null;
  /** That the batch did make it current, as SQL (apps.ts). */
  changed: SQL;
  /**
   * Whether the App's permissions stay as they are, whoever makes it
   * current: only for an App's first version copied from a blueprint,
   * made current for the first time, which was approved as it was created.
   */
  keep: boolean;
}

/**
 * The statements, for the batch that makes a version the current version
 * of an App (apps.ts), for its approval and the App's permissions, each
 * only if the batch did make it current (`changed`). An admin grants a
 * permission trusting the code that will use it, and an App's code runs
 * as whoever uses it, so a builder's next version could otherwise write
 * a shared collection, say, as the next admin who opens it.
 *
 * The version is approved (`app_versions.approved`, which `authorize`
 * reads) if `by` could grant the permissions themselves (`canGrantSql`),
 * and unapproved otherwise. And unless `by` could, or the permissions are
 * kept (`keep`), each of the App's permissions active when the batch runs
 * that lets it change things for the person using it (`changesThingsSql`),
 * and each workflow's grant to call one of its functions (whose code the
 * version holds, run as the person each run acts for), is asked for
 * again: first an audit event for each
 * (`permission.requested`, by `by`, with the version, the one it replaced
 * and who had granted it), then the update, back to requested, asked for
 * by `by`, keeping who granted it and when. Both select their rows with the same condition when the batch
 * runs, nothing read before it, so a grant made just before is asked for
 * again too. The App's own grants that only read are kept: the code
 * reads what the person may.
 * Core's database has no full-text index, so nothing in the batch moves
 * `changes()` under them.
 */
export const madeCurrent = (
  env: Env,
  by: Identity,
  { app, version, previous, changed, keep }: MadeCurrent
): BatchItem<"sqlite">[] => {
  const db = drizzle(env.DB);
  const approval = db
    .update(appVersions)
    .set({
      approved: keep ? 1 : sql`CASE WHEN ${canGrantSql(by)} THEN 1 ELSE 0 END`,
    })
    .where(
      and(eq(appVersions.appId, app), eq(appVersions.version, version), changed)
    );
  if (keep) {
    return [approval];
  }
  // The App's own grants that change things, and the workflows' grants
  // to call its functions: both trust the code of the version made
  // current, so both are asked for again alike.
  const requestedAgain = and(
    or(
      and(ofSubject({ type: "app", appId: app }), changesThingsSql),
      and(
        eq(permissions.subjectType, "workflow"),
        eq(permissions.objectType, "app"),
        eq(permissions.objectId, app),
        isNotNull(permissions.resource),
        sql`EXISTS (SELECT 1 FROM workflow_resources AS live
          WHERE live.id = ${permissions.subjectId} AND live.deleted_at IS NULL)`
      )
    ),
    eq(permissions.status, "active"),
    changed,
    sql`NOT ${canGrantSql(by)}`
  );
  const now = new Date();
  const eventId = eventIdSql(crypto.randomUUID());
  const event = sql`json_object(
    'id', ${eventId},
    'at', ${now.toISOString()},
    'source', 'core',
    'actor', json(${JSON.stringify(actorOf(by))}),
    'action', 'permission.requested',
    'target', json_object('type', 'permission', 'id', ${permissions.id}),
    'provenance', json('[]'),
    'detail', json_set(
      ${auditDetailSql},
      '$.actions', ${joined(permissions.actions)},
      '$.binding', ${permissions.binding},
      '$.version', ${version},
      '$.previous', ${previous},
      '$.grantedBy', ${permissions.grantedBy}
    )
  )`;
  return [
    approval,
    db
      .insert(auditOutbox)
      .select(
        sql`SELECT ${eventId}, ${event}, ${now.getTime()} FROM ${permissions} WHERE ${requestedAgain}`
      ),
    db
      .update(permissions)
      // Who granted it, and when, stay: a request with them is one asked
      // for again (`Permission.grantedBy`). Only the status allows.
      // Asked for by `by` now, a person: not the agent that once may have.
      .set({
        status: "requested",
        requestedBy: by.userId,
        requestedAt: now,
        requestedVia: null,
      })
      .where(requestedAgain),
  ];
};

/**
 * Revokes a permission, requested or active: the next call that needs it
 * is refused. Revoking one that is already revoked changes nothing.
 */
export const revokePermission = async (
  env: Env,
  by: Identity,
  id: unknown
): Promise<Permission> => {
  requireMemberAdmin(by);
  const found = await findRow(env, parseId(id));
  // A chat's request for its person's own connection is theirs alone.
  if (!found || found.personal) {
    throw permissionErrors.create("permission.not_found");
  }
  const db = drizzle(env.DB);
  const revokedAt = new Date();
  const [[revoked]] = await auditedBatch(env, db, [
    db
      .update(permissions)
      .set({ status: "revoked", revokedBy: by.userId, revokedAt })
      .where(
        and(
          eq(permissions.id, found.id),
          inArray(permissions.status, ["requested", "active"]),
          stillAdminSql(by)
        )
      )
      .returning(),
    outboxedIfChanged(
      db,
      changeEntry(by, "permission.revoked", toPermission(found))
    ),
    ...(found.objectType === "workflow"
      ? [
          workflowGenerationMoved(
            db,
            found.objectId,
            sql`EXISTS (SELECT 1 FROM ${permissions}
              WHERE ${eq(permissions.id, found.id)}
                AND ${eq(permissions.status, "revoked")}
                AND ${eq(permissions.revokedAt, revokedAt)})`
          ),
        ]
      : []),
  ]);
  if (!revoked) {
    await requireStillAdmin(env, by);
    // Already revoked: nothing changed, and nothing is recorded.
    return toPermission((await findRow(env, found.id)) ?? found);
  }
  const permission = toPermission(revoked);
  await tellPolicyChanged(env, permission.subject);
  // A chat's request that waited: revoking it decides it, so the chat's
  // agent is told, and its card goes.
  if (found.status === "requested") {
    await tellChat(env, permission, "denied");
  }
  return permission;
};

/**
 * Every permission, or those of one App or agent, oldest first; only those
 * in `status` when given. With `openApps` (a condition on `apps`: the Apps
 * the person has a role in, as `appsFoundBy` in app-access.ts says), one that
 * names an App, as its subject or as a workflow's, only if that App is one
 * of them.
 */
export const listPermissions = async (
  env: Env,
  by: Pick<Identity, "role">,
  subject?: unknown,
  openApps?: SQL,
  status?: unknown,
  /** Only the workflows' grants to call App `calling`'s functions. */
  calling?: AppId
): Promise<Permission[]> => {
  requireBuilder(by);
  const inStatus =
    status === undefined
      ? undefined
      : eq(
          permissions.status,
          permissionErrors.parse(
            "permission.invalid",
            permissionStatusSchema,
            status
          )
        );
  const db = drizzle(env.DB);
  const open = db.select({ id: apps.id }).from(apps).where(openApps);
  // Both Apps a permission names, its subject and the App an agent calls,
  // must be open to the person: an agent's permission on a hidden App
  // would name that App otherwise. Workflows a permission names
  // are filtered by the person's roles in them (permissions-open.ts).
  const ofOpenApp =
    openApps === undefined
      ? undefined
      : and(
          or(
            ne(permissions.subjectType, "app"),
            inArray(permissions.subjectId, open)
          ),
          or(
            ne(permissions.objectType, "app"),
            inArray(permissions.objectId, open)
          )
        );
  const ofOne =
    subject === undefined
      ? undefined
      : ofSubject(
          permissionErrors.parse(
            "permission.invalid",
            permissionSubjectSchema,
            subject
          )
        );
  const rows = await db
    .select()
    .from(permissions)
    // A chat's request for its person's own connection, and why its agent
    // asked, are that person's alone: never listed to admins or builders.
    .where(
      and(
        ofOne,
        ofOpenApp,
        inStatus,
        calling === undefined
          ? undefined
          : and(
              eq(permissions.subjectType, "workflow"),
              eq(permissions.objectType, "app"),
              eq(permissions.objectId, calling),
              isNotNull(permissions.resource)
            ),
        eq(permissions.personal, false),
        servedSql
      )
    )
    .orderBy(asc(permissions.requestedAt), asc(permissions.id));
  return rows.map((row) => toPermission(row));
};

/**
 * Whether `by` publishing a draft of the App that holds `permission` would
 * ask an admin for it again, as `madeCurrent` does: one that changes
 * things, unless `by` could grant it (one of the organization's own
 * admins).
 */
export const askedAgainBy = (
  by: Pick<Identity, "role" | "staff">,
  permission: Permission
): boolean =>
  !isMemberAdmin(by) &&
  permission.actions.some((action) => changesThings(permission.object, action));

/**
 * The person an App or agent acts for must still be in the organization:
 * nothing works for someone who has left or was removed.
 */
export const requireActivePerson = async (
  env: Env,
  authority: Authority
): Promise<void> => {
  if ((await memberRole(env.DB, authority.onBehalfOf)) === undefined) {
    throw permissionErrors.create("permission.person_inactive");
  }
};

/**
 * A subject's permissions in any of `statuses` that hold `where`
 * (`holdsIn`), in the order asked for. No two share a binding: a chat's
 * own and one that holds everywhere never both go live under one name
 * (`noBindingClash`).
 */
const permissionsIn = async (
  env: Env,
  subject: PermissionSubject,
  statuses: PermissionStatus[],
  where?: Where
): Promise<Permission[]> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(permissions)
    .where(
      and(
        ofSubject(subject),
        inArray(permissions.status, statuses),
        holdsIn(where)
      )
    )
    .orderBy(asc(permissions.requestedAt), asc(permissions.id));
  return rows.map((row) => toPermission(row));
};

/**
 * The active permissions of an App or agent, whoever it acts for, that
 * hold `where` (`holdsIn`). Only for building an env whose stubs check
 * the person on every call.
 */
export const activePermissions = async (
  env: Env,
  subject: PermissionSubject,
  where?: Where
): Promise<Permission[]> =>
  await permissionsIn(env, subject, ["active"], where);

/**
 * The active permissions of the App or agent `authority` names that hold
 * in `context`: a chat's own ones only in that chat.
 */
export const grantedPermissions = async (
  env: Env,
  authority: Authority,
  context?: WorkContext
): Promise<Permission[]> => {
  await requireActivePerson(env, authority);
  return await activePermissions(env, authority.subject, {
    context,
    onBehalfOf: authority.onBehalfOf,
  });
};

/**
 * The permission check. Every server path that lets an App or agent touch a
 * connection, a collection or a workflow calls it first, on every call:
 * the person it acts for is still a member, and `permissionId` (the
 * permission the stub was built from) is active, of that exact subject,
 * covers the object and allows the action. Only that permission counts, so
 * revoking it stops its stubs even when another permission covers the same
 * thing. A permission for a whole connection covers each resource in it;
 * one for a resource covers only that resource. For an App's code, an
 * action that changes things (on a connection, or other than `read`) also
 * needs the version it runs to be one an admin approved (`madeCurrent`).
 * A chat's own permission allows only in that chat, `context` (none
 * given: nowhere), and only for the person who asked for it there. Throws `permission.denied`
 * or `permission.person_inactive` otherwise.
 *
 * It doesn't intersect the grant with the person's own access (R5): connect
 * does that for personal connections, and the Knowledge queries for
 * collections.
 */
export const authorize = async (
  env: Env,
  authority: Authority,
  object: PermissionObject,
  action: string,
  permissionId: PermissionId,
  context?: WorkContext
): Promise<void> => {
  await requireActivePerson(env, authority);
  const allowing = await drizzle(env.DB)
    .select({ id: permissions.id })
    .from(permissions)
    .where(
      and(
        allowingPermissionSql(
          authority.subject,
          authority.appVersion,
          object,
          action,
          changesThings(object, action),
          { context, onBehalfOf: authority.onBehalfOf }
        ),
        eq(permissions.id, permissionId)
      )
    )
    .get();
  if (!allowing) {
    throw permissionErrors.create("permission.denied", { action });
  }
};
