import type { AppRole } from "@grasp-os/shared/apps";
import { actorOf, createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import {
  fileItemSchema,
  newProjectMemberSchema,
  newProjectSchema,
  projectChangesSchema,
  projectErrors,
  projectIcons,
  projectItemRefSchema,
  projectMemberRefSchema,
} from "@grasp-os/shared/projects";
import type {
  FileItem,
  NewProject,
  NewProjectMember,
  Project,
  ProjectChanges,
  ProjectCounts,
  ProjectIcon,
  ProjectItem,
  ProjectItemCandidate,
  ProjectItemRef,
  ProjectMember,
  ProjectMemberRef,
  ProjectRole,
  ProjectShareCandidates,
  ProjectSummary,
  ProjectsApi,
} from "@grasp-os/shared/projects";
import { requireBuilder } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { WorkflowResource } from "@grasp-os/shared/workflow-resources";
import { and, asc, desc, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  appsSharedWithProject,
  revocationsOf,
  tellKept,
} from "./access-revocations.ts";
import { addMember } from "./app-members.ts";
import { appFor, listApps } from "./apps.ts";
import {
  auditedBatch,
  outboxed,
  outboxedEventWhere,
  outboxedIfChanged,
  storedEvent,
} from "./audit-outbox.ts";
import { activeMember, notRemoved, organizationId } from "./auth/auth.ts";
import {
  apps,
  appMembers,
  members,
  permissions,
  projectItems,
  projectMembers,
  projects,
  teams,
  users,
  workflowResourceMembers,
  workflowResources,
} from "./db/core/schema.ts";
import { inList, notNullFailed } from "./db/d1.ts";
import {
  peopleInProject,
  projectRefusal,
  projectsFoundBy,
  requireProjectRole,
  rolesIn,
} from "./project-access.ts";
import type { ProjectRow } from "./project-access.ts";
import {
  projectBuiltBySql,
  projectWithRoomForItemSql,
  projectWithRoomForMemberSql,
} from "./project-sql.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { memberEntry, requireNotStaff, requireSharable } from "./sharing.ts";
import {
  listWorkflowResources,
  nextGeneration,
  nextGenerationWhere,
  requireWorkflowRole,
  shareWorkflowResource,
} from "./workflow-resources.ts";

// Projects (GRA-1458): an optional grouping of Apps and workflows for a
// process, team or goal, with a name, a description, an icon and whoever is
// in it (project-access.ts). Connections are never grouped: a project
// counts those its items use. Deleting a project never deletes its items.
//
// The safety rule is that filing never shares. The ways it could fail, and
// what stops each:
//
// - Filing widening access: filing writes `project_items` alone, which no
//   access check reads. An item reaches a project's people only through a
//   `project` row in its own sharing list (`app_members`,
//   `workflow_resource_members`), which only a builder of the item who
//   also builds the project adds (`share`, off by default; or the item's
//   own Share dialog), with every per-person check sharing makes
//   (`app.share_unreadable` for each person the project reaches).
// - A project's people seeing what they weren't shared: its page and its
//   counts list only what the asker opens anyway (`listApps`,
//   `listWorkflowResources`), so an item filed but not shared with them is
//   neither named nor counted.
// - Access kept after it is taken away: a `project` row is read against
//   `project_members` and `team_members` in the statement that decides
//   (sharing.ts, `projectsOfSql`). Taking someone out of a project, an item
//   out of it, or deleting it keeps a revocation for each App it reached in
//   the same batch (access-revocations.ts), and moves each workflow's
//   policy generation on, so open screens clear and admitted starts are
//   refused.
// - A project's name leaking: a project isn't there for anyone not in it
//   (`project.not_found`), and an item's sharing list names its project row
//   only to people in the project.
// - Grasp staff deciding whom a client's data reaches: they change no
//   project, as they share nothing.
//
// Every change is audited in the batch that makes it, naming the project
// by ID, never its name or description: the log holds no content.

/** The audit log's target type of a project. */
const targetType = "project";

/** The audit entry of `by`'s `action` on project `id`. */
const entry = (
  by: Identity,
  action: string,
  id: string,
  detail: AuditEntry["detail"] = {}
): AuditEntry => ({
  actor: actorOf(by),
  action,
  target: { type: targetType, id },
  detail,
});

const invalid = (issue: string) =>
  projectErrors.create("project.member_invalid", { issues: [issue] });

/** An icon as stored, read back as one of ours. */
const iconOf = (icon: string): ProjectIcon =>
  projectIcons.find((each) => each === icon) ?? "folder";

/** What `by` may open now: their Apps and live workflows, by ID. */
interface Visible {
  apps: Map<string, { name: string; role: AppRole }>;
  workflows: Map<string, Pick<WorkflowResource, "name" | "role">>;
}

/**
 * What `by` may open, as their own lists of Apps and workflows decide it:
 * a project shows nothing beyond it.
 */
const visibleTo = async (env: Env, by: Identity): Promise<Visible> => {
  const [openApps, openWorkflows] = await Promise.all([
    listApps(env, by),
    listWorkflowResources(env, by),
  ]);
  return {
    apps: new Map(openApps.map(({ id, name, role }) => [id, { name, role }])),
    workflows: new Map(
      openWorkflows.map(({ id, name, role }) => [id, { name, role }])
    ),
  };
};

/** Whether `by` may open `item` (`visibleTo`). */
const opens = (visible: Visible, item: ProjectItemRef): boolean =>
  item.type === "app"
    ? visible.apps.has(item.id)
    : visible.workflows.has(item.id);

/** An item in one of the projects read. */
interface InProject extends ProjectItemRef {
  projectId: string;
}

/**
 * The items in `ids`' projects, each once, oldest first: those filed in
 * them and those shared with them, filed or not, so a project shows
 * everything being in it reaches (an item's own Share dialog shares
 * without filing).
 */
const itemsIn = async (
  env: Env,
  ids: readonly string[]
): Promise<InProject[]> => {
  if (ids.length === 0) {
    return [];
  }
  const rows = await drizzle(env.DB).all<{
    projectId: string;
    type: string;
    id: string;
  }>(sql`SELECT projectId, type, id FROM (
      SELECT ${projectItems.projectId} AS projectId, ${projectItems.itemType} AS type, ${projectItems.itemId} AS id, ${projectItems.addedAt} AS at
        FROM ${projectItems} WHERE ${inList(projectItems.projectId, ids)}
      UNION ALL SELECT ${appMembers.memberId}, 'app', ${appMembers.appId}, ${appMembers.addedAt}
        FROM ${appMembers} WHERE ${appMembers.memberType} = 'project' AND ${inList(appMembers.memberId, ids)}
      UNION ALL SELECT ${workflowResourceMembers.memberId}, 'workflow', ${workflowResourceMembers.workflowResourceId}, ${workflowResourceMembers.addedAt}
        FROM ${workflowResourceMembers} WHERE ${workflowResourceMembers.memberType} = 'project' AND ${inList(workflowResourceMembers.memberId, ids)}
    ) ORDER BY at, id`);
  const seen = new Set<string>();
  return rows.flatMap(({ projectId, type, id }): InProject[] => {
    const key = `${projectId}:${type}:${id}`;
    if (seen.has(key) || (type !== "app" && type !== "workflow")) {
      return [];
    }
    seen.add(key);
    return [{ projectId, type, id }];
  });
};

/**
 * The connections each of `items` uses, by item key (`type:id`): those it
 * holds a grant on that isn't revoked.
 */
const connectionsOf = async (
  env: Env,
  items: readonly ProjectItemRef[]
): Promise<Map<string, Set<string>>> => {
  const appIds = items.filter(({ type }) => type === "app").map(({ id }) => id);
  const workflowIds = items
    .filter(({ type }) => type === "workflow")
    .map(({ id }) => id);
  const byItem = new Map<string, Set<string>>();
  if (appIds.length === 0 && workflowIds.length === 0) {
    return byItem;
  }
  const rows = await drizzle(env.DB)
    .selectDistinct({
      type: permissions.subjectType,
      id: permissions.subjectId,
      connection: permissions.objectId,
    })
    .from(permissions)
    .where(
      and(
        eq(permissions.objectType, "connection"),
        ne(permissions.status, "revoked"),
        or(
          appIds.length === 0
            ? undefined
            : and(
                eq(permissions.subjectType, "app"),
                inList(permissions.subjectId, appIds)
              ),
          workflowIds.length === 0
            ? undefined
            : and(
                eq(permissions.subjectType, "workflow"),
                inList(permissions.subjectId, workflowIds)
              )
        )
      )
    );
  for (const { type, id, connection } of rows) {
    const key = `${type}:${id}`;
    const set = byItem.get(key) ?? new Set<string>();
    set.add(connection);
    byItem.set(key, set);
  }
  return byItem;
};

/** The counts of `items`, each one `by` opens. */
const countsOf = (
  items: readonly ProjectItemRef[],
  connections: Map<string, Set<string>>
): ProjectCounts => {
  const used = new Set<string>();
  for (const { type, id } of items) {
    for (const connection of connections.get(`${type}:${id}`) ?? []) {
      used.add(connection);
    }
  }
  return {
    apps: items.filter(({ type }) => type === "app").length,
    workflows: items.filter(({ type }) => type === "workflow").length,
    connections: used.size,
  };
};

const summaryOf = (
  project: ProjectRow,
  role: ProjectRole,
  counts: ProjectCounts
): ProjectSummary => ({
  id: project.id,
  name: project.name,
  description: project.description,
  icon: iconOf(project.icon),
  role,
  counts,
});

/** The projects `by` is in, newest first; every one for an admin. */
export const listProjects = async (
  env: Env,
  by: Identity
): Promise<ProjectSummary[]> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(projects)
    .where(projectsFoundBy(by))
    .orderBy(desc(projects.createdAt), asc(projects.id));
  if (rows.length === 0) {
    return [];
  }
  const [visible, inThem, roles] = await Promise.all([
    visibleTo(env, by),
    itemsIn(
      env,
      rows.map(({ id }) => id)
    ),
    rolesIn(env, by, rows),
  ]);
  const shown = inThem.filter((item) => opens(visible, item));
  const connections = await connectionsOf(env, shown);
  return rows.flatMap((row) => {
    const role = roles.get(row.id);
    if (role === undefined) {
      return [];
    }
    const own = shown.filter(({ projectId }) => projectId === row.id);
    return [summaryOf(row, role, countsOf(own, connections))];
  });
};

/** Who is in project `id` besides its owner, named, still there. */
const membersOf = async (env: Env, id: string): Promise<ProjectMember[]> => {
  const rows = await drizzle(env.DB)
    .select({ row: projectMembers, person: users.name, team: teams.name })
    .from(projectMembers)
    .leftJoin(
      users,
      and(
        eq(projectMembers.memberType, "person"),
        eq(users.id, projectMembers.memberId)
      )
    )
    .leftJoin(
      teams,
      and(
        eq(projectMembers.memberType, "team"),
        eq(teams.id, projectMembers.memberId),
        eq(teams.organizationId, organizationId)
      )
    )
    .where(
      and(
        eq(projectMembers.projectId, id),
        or(
          and(
            eq(projectMembers.memberType, "person"),
            activeMember(projectMembers.memberId)
          ),
          and(eq(projectMembers.memberType, "team"), isNotNull(teams.id))
        )
      )
    )
    .orderBy(
      asc(projectMembers.addedAt),
      asc(projectMembers.memberType),
      asc(projectMembers.memberId)
    );
  return rows.map(({ row, person, team }) => ({
    type: row.memberType,
    id: row.memberId,
    name: person ?? team,
    role: row.role,
    addedBy: row.addedBy,
    addedAt: row.addedAt.toISOString(),
  }));
};

/** The role project `id`'s row has in each item shared with it, by item key. */
const sharedWithProject = async (
  env: Env,
  id: string
): Promise<Map<string, ProjectRole>> => {
  const db = drizzle(env.DB);
  const [sharedApps, sharedWorkflows] = await db.batch([
    db
      .select({ id: appMembers.appId, role: appMembers.role })
      .from(appMembers)
      .where(
        and(eq(appMembers.memberType, "project"), eq(appMembers.memberId, id))
      ),
    db
      .select({
        id: workflowResourceMembers.workflowResourceId,
        role: workflowResourceMembers.role,
      })
      .from(workflowResourceMembers)
      .where(
        and(
          eq(workflowResourceMembers.memberType, "project"),
          eq(workflowResourceMembers.memberId, id)
        )
      ),
  ]);
  return new Map([
    ...sharedApps.map(({ id: app, role }): [string, ProjectRole] => [
      `app:${app}`,
      role,
    ]),
    ...sharedWorkflows.map(({ id: workflow, role }): [string, ProjectRole] => [
      `workflow:${workflow}`,
      role,
    ]),
  ]);
};

/** Project `id`, as its page shows it to `by`, who is in it. */
export const getProject = async (
  env: Env,
  by: Identity,
  id: unknown
): Promise<Project> => {
  const { project, role } = await requireProjectRole(env, by, id, "user");
  const [visible, filed, shared, projectMembersList, people, owner] =
    await Promise.all([
      visibleTo(env, by),
      itemsIn(env, [project.id]),
      sharedWithProject(env, project.id),
      membersOf(env, project.id),
      peopleInProject(env, project.id),
      drizzle(env.DB)
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, project.ownerId))
        .get(),
    ]);
  const shown = filed.filter((item) => opens(visible, item));
  const connections = await connectionsOf(env, shown);
  const items = shown.map(({ type, id: itemId }): ProjectItem => {
    const seen =
      type === "app" ? visible.apps.get(itemId) : visible.workflows.get(itemId);
    return {
      type,
      id: itemId,
      name: seen?.name ?? "",
      sharedAs: shared.get(`${type}:${itemId}`) ?? null,
      builds: seen?.role === "builder",
    };
  });
  return {
    ...summaryOf(project, role, countsOf(shown, connections)),
    owner: { id: project.ownerId, name: owner?.name ?? null },
    members: projectMembersList,
    people: people.length,
    items,
  };
};

/** Makes a project for `by`, its owner, with nothing in it. */
export const createProject = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<ProjectSummary> => {
  requireNotStaff(by);
  // Only someone whose role builds makes a project, as an App: its builders
  // decide whom what is shared with it reaches (project-access.ts).
  requireBuilder(by);
  const made = projectErrors.parse("project.invalid", newProjectSchema, input);
  const row: ProjectRow = {
    id: crypto.randomUUID(),
    name: made.name,
    description: made.description,
    icon: made.icon,
    ownerId: by.userId,
    createdAt: new Date(),
  };
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db.insert(projects).values(row),
    outboxed(db, entry(by, "project.created", row.id)),
  ]);
  return summaryOf(row, "builder", { apps: 0, workflows: 0, connections: 0 });
};

/** The columns a project write's guard (project-sql.ts) leaves NULL. */
const guardedColumns = [
  "projects.name",
  "project_members.project_id",
  "project_items.project_id",
] as const;

/**
 * `write`, a batch that writes to project `id` under a guard read in its
 * own statements (`stillBuilds`, project-sql.ts): when a guard fails the
 * batch, nothing is written, and it is answered as `projectRefusal` says
 * (deleted, no longer `by`'s to build, or full) since it was checked.
 */
const guarded = async <T>(
  env: Env,
  id: string,
  by: Identity,
  write: () => Promise<T>
): Promise<T> => {
  try {
    return await write();
  } catch (error) {
    if (guardedColumns.some((column) => notNullFailed(error, column))) {
      throw await projectRefusal(env, id, by.userId);
    }
    throw error;
  }
};

/**
 * A batch's first statement for a write to project `id` by `by`: it
 * fails the batch (NOT NULL on `projects.name`) unless `by` builds the
 * project when the batch runs, so a builder removed or demoted while
 * their call was under way changes nothing. It changes no row's data.
 */
const stillBuilds = (
  db: ReturnType<typeof drizzle>,
  id: string,
  by: Identity
) =>
  db
    .update(projects)
    .set({
      name: sql`CASE WHEN ${projectBuiltBySql(id, by.userId)} THEN ${projects.name} ELSE NULL END`,
    })
    .where(eq(projects.id, id));

/** Changes project `id`'s name, description or icon, for its builders. */
export const updateProject = async (
  env: Env,
  by: Identity,
  id: unknown,
  input: unknown
): Promise<void> => {
  requireNotStaff(by);
  const { project } = await requireProjectRole(env, by, id, "builder");
  const changes = projectErrors.parse(
    "project.invalid",
    projectChangesSchema,
    input
  );
  const set = Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== undefined)
  );
  const db = drizzle(env.DB);
  await guarded(env, project.id, by, async () => {
    await auditedBatch(env, db, [
      stillBuilds(db, project.id, by),
      db.update(projects).set(set).where(eq(projects.id, project.id)),
      outboxedIfChanged(
        db,
        entry(by, "project.updated", project.id, {
          changed: Object.keys(set).toSorted().join(","),
        })
      ),
    ]);
  });
};

/**
 * That something was shared with project `id`: the workflows shared with
 * it, as a condition on `workflow_resources`.
 */
const workflowsSharedWithProject = (id: string) =>
  sql`${workflowResources.id} IN (SELECT ${workflowResourceMembers.workflowResourceId} FROM ${workflowResourceMembers} WHERE ${workflowResourceMembers.memberType} = 'project' AND ${workflowResourceMembers.memberId} = ${id})`;

/**
 * Deletes project `id`, for its builders: its rows, its members and what
 * is filed in it, and every share with it, so nobody keeps what it
 * reached. Nothing filed in it is deleted.
 */
export const removeProject = async (
  env: Env,
  by: Identity,
  id: unknown
): Promise<void> => {
  requireNotStaff(by);
  const { project } = await requireProjectRole(env, by, id, "builder");
  const db = drizzle(env.DB);
  const event = createAuditEvent(
    entry(by, "project.deleted", project.id),
    "core"
  );
  const [, revocations] = await guarded(
    env,
    project.id,
    by,
    async () =>
      await auditedBatch(env, db, [
        stillBuilds(db, project.id, by),
        // Read before the shares go: the Apps whose screens look again.
        revocationsOf(db, appsSharedWithProject(project.id), null, sql`1 = 1`),
        nextGenerationWhere(db, workflowsSharedWithProject(project.id)),
        db
          .delete(appMembers)
          .where(
            and(
              eq(appMembers.memberType, "project"),
              eq(appMembers.memberId, project.id)
            )
          ),
        db
          .delete(workflowResourceMembers)
          .where(
            and(
              eq(workflowResourceMembers.memberType, "project"),
              eq(workflowResourceMembers.memberId, project.id)
            )
          ),
        db.delete(projectItems).where(eq(projectItems.projectId, project.id)),
        db
          .delete(projectMembers)
          .where(eq(projectMembers.projectId, project.id)),
        db.delete(projects).where(eq(projects.id, project.id)),
        outboxedEventWhere(db, event, sql`changes() > 0`),
      ])
  );
  await tellKept(env, revocations);
};

/** The rows of project `id` that are `member`. */
const memberRowOf = (id: string, member: ProjectMemberRef) =>
  and(
    eq(projectMembers.projectId, id),
    eq(projectMembers.memberType, member.type),
    eq(projectMembers.memberId, member.id)
  );

/**
 * Adds a person or team to project `id`, or gives them another role in
 * it, for its builders: they reach what is shared with the project from
 * their next call, each still only as their own checks allow
 * (app-access.ts). Adding again in the same role records nothing.
 */
export const addProjectMember = async (
  env: Env,
  by: Identity,
  id: unknown,
  input: unknown
): Promise<void> => {
  requireNotStaff(by);
  const { project } = await requireProjectRole(env, by, id, "builder");
  const member = projectErrors.parse(
    "project.invalid",
    newProjectMemberSchema,
    input
  );
  await requireSharable(env, member, {
    owner: project.ownerId,
    builds: member.role === "builder",
    invalid,
    ownerIssue: "id: They own the project, and always build it.",
    buildsIssue:
      "role: Only the organization's admins and builders build projects.",
  });
  const db = drizzle(env.DB);
  const addedAt = new Date();
  const batch = auditedBatch(env, db, [
    db
      .insert(projectMembers)
      .values({
        // Only while the project is there, still theirs to build, with
        // room for them: otherwise NULL, which fails the batch, so an add
        // racing a deletion, a demotion or another add writes nothing.
        projectId: projectWithRoomForMemberSql(project.id, member, by.userId),
        memberType: member.type,
        memberId: member.id,
        role: member.role,
        addedBy: by.userId,
        addedAt,
      })
      .onConflictDoUpdate({
        target: [
          projectMembers.projectId,
          projectMembers.memberType,
          projectMembers.memberId,
        ],
        set: { role: member.role, addedBy: by.userId, addedAt },
        setWhere: ne(projectMembers.role, member.role),
      }),
    outboxedIfChanged(
      db,
      memberEntry(
        by,
        "project.member.added",
        { type: targetType, id: project.id },
        member
      )
    ),
  ]);
  await guarded(env, project.id, by, async () => await batch);
};

/**
 * Takes a person or team out of project `id`, for its builders: what is
 * shared with the project stops reaching them on their next call, their
 * open screens of its Apps look again, and its workflows' admitted starts
 * are refused. Taking out someone not in it changes nothing.
 */
export const removeProjectMember = async (
  env: Env,
  by: Identity,
  id: unknown,
  input: unknown
): Promise<void> => {
  requireNotStaff(by);
  const { project } = await requireProjectRole(env, by, id, "builder");
  const member = projectErrors.parse(
    "project.invalid",
    projectMemberRefSchema,
    input
  );
  const db = drizzle(env.DB);
  const before = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(memberRowOf(project.id, member))
    .get();
  if (before === undefined) {
    return;
  }
  const event = createAuditEvent(
    memberEntry(
      by,
      "project.member.removed",
      { type: targetType, id: project.id },
      { ...member, role: before.role }
    ),
    "core"
  );
  const results = await guarded(
    env,
    project.id,
    by,
    async () =>
      await auditedBatch(env, db, [
        stillBuilds(db, project.id, by),
        db.delete(projectMembers).where(memberRowOf(project.id, member)),
        outboxedEventWhere(db, event, sql`changes() > 0`),
        revocationsOf(
          db,
          appsSharedWithProject(project.id),
          member.type === "person" ? [member.id] : null,
          storedEvent(event.id)
        ),
        nextGenerationWhere(
          db,
          and(workflowsSharedWithProject(project.id), storedEvent(event.id))
        ),
      ])
  );
  await tellKept(env, results[3]);
};

/** Whom a builder of project `id` may add to it. */
export const projectShareCandidates = async (
  env: Env,
  by: Identity,
  id: unknown
): Promise<ProjectShareCandidates> => {
  requireNotStaff(by);
  await requireProjectRole(env, by, id, "builder");
  const db = drizzle(env.DB);
  const [people, organizationTeams] = await Promise.all([
    db
      .select({ id: users.id, name: users.name })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(
        and(
          eq(members.organizationId, organizationId),
          notRemoved(members.userId)
        )
      )
      .orderBy(asc(users.name), asc(users.id)),
    db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(eq(teams.organizationId, organizationId))
      .orderBy(asc(teams.name), asc(teams.id)),
  ]);
  return { people, teams: organizationTeams };
};

/** What `by` may file in project `id`: what they open, not in it yet. */
export const projectItemCandidates = async (
  env: Env,
  by: Identity,
  id: unknown
): Promise<ProjectItemCandidate[]> => {
  const { project } = await requireProjectRole(env, by, id, "builder");
  const [visible, filed] = await Promise.all([
    visibleTo(env, by),
    itemsIn(env, [project.id]),
  ]);
  const inIt = new Set(filed.map(({ type, id: item }) => `${type}:${item}`));
  return [
    ...[...visible.apps].map(([app, { name, role }]): ProjectItemCandidate => ({
      type: "app",
      id: app,
      name,
      builds: role === "builder",
    })),
    ...[...visible.workflows].map(
      ([workflow, { name, role }]): ProjectItemCandidate => ({
        type: "workflow",
        id: workflow,
        name,
        builds: role === "builder",
      })
    ),
  ].filter(({ type, id: item }) => !inIt.has(`${type}:${item}`));
};

/**
 * The item `ref` names, which `by` must open: its ID as stored. Refuses
 * one they can't open as one that isn't there.
 */
const openedItem = async (
  env: Env,
  by: Identity,
  ref: ProjectItemRef
): Promise<string> => {
  if (ref.type === "app") {
    const app = await appFor(env, by, ref.id, "user");
    return app.id;
  }
  const workflow = await requireWorkflowRole(env, by, ref.id, "user");
  return workflow.id;
};

/** Whether `item` is shared with project `id` already, in any role. */
const sharedAlready = async (
  env: Env,
  id: string,
  item: ProjectItemRef
): Promise<boolean> => {
  const db = drizzle(env.DB);
  const row =
    item.type === "app"
      ? await db
          .select({ one: sql`1` })
          .from(appMembers)
          .where(
            and(
              eq(appMembers.appId, item.id),
              eq(appMembers.memberType, "project"),
              eq(appMembers.memberId, id)
            )
          )
          .get()
      : await db
          .select({ one: sql`1` })
          .from(workflowResourceMembers)
          .where(
            and(
              eq(workflowResourceMembers.workflowResourceId, item.id),
              eq(workflowResourceMembers.memberType, "project"),
              eq(workflowResourceMembers.memberId, id)
            )
          )
          .get();
  return row !== undefined;
};

/**
 * Files an App or workflow `by` opens in project `id`, for its builders.
 * Filing shares nothing. With `share`, it is also shared with everyone in
 * the project as users, as the item's own sharing does it, so only for a
 * builder of the item and with every check that makes: shared first, so a
 * refused share files nothing. A share the item has with the project
 * already is kept as it is.
 */
export const fileItem = async (
  env: Env,
  by: Identity,
  id: unknown,
  input: unknown
): Promise<void> => {
  requireNotStaff(by);
  const { project } = await requireProjectRole(env, by, id, "builder");
  const { item, share } = projectErrors.parse(
    "project.invalid",
    fileItemSchema,
    input
  );
  const itemId = await openedItem(env, by, item);
  const ref: ProjectItemRef = { type: item.type, id: itemId };
  // Whether this call shares it: a share it has already is kept as it is.
  const shares = share && !(await sharedAlready(env, project.id, ref));
  if (shares) {
    const toProject = {
      type: "project",
      id: project.id,
      role: "user",
    } as const;
    await (ref.type === "app"
      ? addMember(env, by, itemId, toProject)
      : shareWorkflowResource(env, by, itemId, toProject));
  }
  const db = drizzle(env.DB);
  const batch = auditedBatch(env, db, [
    db
      .insert(projectItems)
      .values({
        // Only while the project is there with room for it, or holds it
        // already: otherwise NULL, which fails the batch.
        projectId: projectWithRoomForItemSql(project.id, ref, by.userId),
        itemType: ref.type,
        // Only while the item is still there: one removed or deleted
        // since it was opened, after its cleanup ran, would otherwise
        // leave a row nobody sees taking a place.
        itemId:
          ref.type === "app"
            ? sql`(SELECT ${apps.id} FROM ${apps} WHERE ${apps.id} = ${itemId} AND ${apps.removedAt} IS NULL)`
            : sql`(SELECT ${workflowResources.id} FROM ${workflowResources} WHERE ${workflowResources.id} = ${itemId} AND ${workflowResources.deletedAt} IS NULL)`,
        addedBy: by.userId,
        addedAt: new Date(),
      })
      .onConflictDoNothing(),
    outboxedIfChanged(
      db,
      entry(by, "project.item.filed", project.id, {
        itemType: ref.type,
        item: itemId,
        shared: shares,
      })
    ),
  ]);
  // Deleted since the share, if any, which went with nothing to reach.
  await guarded(env, project.id, by, async () => {
    try {
      await batch;
    } catch (error) {
      if (notNullFailed(error, "project_items.item_id")) {
        throw projectErrors.create("project.item_not_found");
      }
      throw error;
    }
  });
};

/**
 * Takes an item out of project `id`, for its builders. Its share with the
 * project goes with it: whom that reached loses it, with the item's own
 * unsharing's revocation and audit. Narrowing whom an item reaches is
 * safe for a project's builder to decide, though they may not build it.
 */
export const unfileItem = async (
  env: Env,
  by: Identity,
  id: unknown,
  input: unknown
): Promise<void> => {
  requireNotStaff(by);
  const { project } = await requireProjectRole(env, by, id, "builder");
  const item = projectErrors.parse(
    "project.invalid",
    projectItemRefSchema,
    input
  );
  const db = drizzle(env.DB);
  const unfiled = db
    .delete(projectItems)
    .where(
      and(
        eq(projectItems.projectId, project.id),
        eq(projectItems.itemType, item.type),
        eq(projectItems.itemId, item.id)
      )
    );
  const unfiledEntry = outboxedIfChanged(
    db,
    entry(by, "project.item.unfiled", project.id, {
      itemType: item.type,
      item: item.id,
    })
  );
  if (item.type === "workflow") {
    const ofProject = and(
      eq(workflowResourceMembers.workflowResourceId, item.id),
      eq(workflowResourceMembers.memberType, "project"),
      eq(workflowResourceMembers.memberId, project.id)
    );
    const before = await db
      .select({ role: workflowResourceMembers.role })
      .from(workflowResourceMembers)
      .where(ofProject)
      .get();
    if (before === undefined) {
      await guarded(env, project.id, by, async () => {
        await auditedBatch(env, db, [
          stillBuilds(db, project.id, by),
          unfiled,
          unfiledEntry,
        ]);
      });
      return;
    }
    const event = createAuditEvent(
      memberEntry(
        by,
        "workflow.member.removed",
        { type: "workflow_resource", id: item.id },
        { type: "project", id: project.id, role: before.role }
      ),
      "core"
    );
    await guarded(env, project.id, by, async () => {
      await auditedBatch(env, db, [
        stillBuilds(db, project.id, by),
        unfiled,
        unfiledEntry,
        db.delete(workflowResourceMembers).where(ofProject),
        outboxedEventWhere(db, event, sql`changes() > 0`),
        nextGeneration(db, item.id, storedEvent(event.id)),
      ]);
    });
    return;
  }
  const ofProject = and(
    eq(appMembers.appId, item.id),
    eq(appMembers.memberType, "project"),
    eq(appMembers.memberId, project.id)
  );
  const before = await db
    .select({ role: appMembers.role })
    .from(appMembers)
    .where(ofProject)
    .get();
  if (before === undefined) {
    await guarded(env, project.id, by, async () => {
      await auditedBatch(env, db, [
        stillBuilds(db, project.id, by),
        unfiled,
        unfiledEntry,
      ]);
    });
    return;
  }
  const event = createAuditEvent(
    memberEntry(
      by,
      "app.member.removed",
      { type: "app", id: item.id },
      { type: "project", id: project.id, role: before.role }
    ),
    "core"
  );
  const unshared = await guarded(
    env,
    project.id,
    by,
    async () =>
      await auditedBatch(env, db, [
        stillBuilds(db, project.id, by),
        unfiled,
        unfiledEntry,
        db.delete(appMembers).where(ofProject),
        outboxedEventWhere(db, event, sql`changes() > 0`),
        // Everyone in the project looks again: who keeps it otherwise is
        // their own check's to say.
        revocationsOf(db, eq(apps.id, item.id), null, storedEvent(event.id)),
      ])
  );
  await tellKept(env, unshared[5]);
};

/** A signed-in person's `projects`. */
export class ProjectsRpc extends CoreRpcTarget implements ProjectsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(): Promise<ProjectSummary[]> {
    return await withPerson(
      this.#check,
      async (by) => await listProjects(this.#env, by)
    );
  }

  async get(id: string): Promise<Project> {
    return await withPerson(
      this.#check,
      async (by) => await getProject(this.#env, by, id)
    );
  }

  async create(project: NewProject): Promise<ProjectSummary> {
    return await withPerson(
      this.#check,
      async (by) => await createProject(this.#env, by, project)
    );
  }

  async update(id: string, changes: ProjectChanges): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await updateProject(this.#env, by, id, changes);
    });
  }

  async remove(id: string): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await removeProject(this.#env, by, id);
    });
  }

  async addMember(id: string, member: NewProjectMember): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await addProjectMember(this.#env, by, id, member);
    });
  }

  async removeMember(id: string, member: ProjectMemberRef): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await removeProjectMember(this.#env, by, id, member);
    });
  }

  async shareCandidates(id: string): Promise<ProjectShareCandidates> {
    return await withPerson(
      this.#check,
      async (by) => await projectShareCandidates(this.#env, by, id)
    );
  }

  async itemCandidates(id: string): Promise<ProjectItemCandidate[]> {
    return await withPerson(
      this.#check,
      async (by) => await projectItemCandidates(this.#env, by, id)
    );
  }

  async file(id: string, file: FileItem): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await fileItem(this.#env, by, id, file);
    });
  }

  async unfile(id: string, item: ProjectItemRef): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await unfileItem(this.#env, by, id, item);
    });
  }
}
