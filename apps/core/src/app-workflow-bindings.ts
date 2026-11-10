import type {
  AppDefinition,
  DefinedWorkflowBinding,
} from "@grasp-os/runtime/definition";
import {
  declaredPermission,
  declaredPermissions,
  sameEventContract,
} from "@grasp-os/runtime/host";
import type { WorkflowEventContract } from "@grasp-os/runtime/host";
import { appErrors } from "@grasp-os/shared/apps";
import type { App } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Authority } from "@grasp-os/shared/permissions";
import {
  appWorkflowBindingSchema,
  workflowResourceErrors,
  workflowStartSchema,
} from "@grasp-os/shared/workflow-resources";
import type {
  AppWorkflowBinding,
  WorkflowStart,
} from "@grasp-os/shared/workflow-resources";
import { and, asc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";

import { loadRelease } from "./app-releases.ts";
import type { Release } from "./app-releases.ts";
import { appFor, editableApp } from "./apps.ts";
import {
  auditedBatch,
  outboxed,
  outboxedIfChanged,
  outboxedWhere,
} from "./audit-outbox.ts";
import { memberOf } from "./auth/identity.ts";
import type { Acting } from "./auth/identity.ts";
import { versionEventContract } from "./bound-workflows.ts";
import {
  appWorkflowBindings,
  workflowResourceVersions,
} from "./db/core/schema.ts";
import { isUniqueViolation, notNullFailed } from "./db/d1.ts";
import { appHost } from "./durable-objects.ts";
import { requireNotStaff } from "./sharing.ts";
import { requireWorkflowRole } from "./workflow-resources.ts";
import { startWorkflow } from "./workflow-starts.ts";
import type { StartingAgent } from "./workflow-starts.ts";
import type { StartFiles } from "./workflows/start-files.ts";

// Apps binding independent workflows (platform specification 3, 13.1,
// 15.1): an App names an exact version of a workflow by an alias of its
// own, and its code starts that version through the alias. The App never
// owns the workflow nor gains its grants. Threat model, and how each is
// closed:
//
// - Grouping or binding as a grant: a binding pins a version and nothing
//   more. Starting through it still takes the App's own `start`
//   permission on the workflow, granted by an admin, from a version of the
//   App an admin approved (workflow-starts.ts).
// - Binding a version you can't use: only someone who builds the App and
//   has a role in the workflow binds it, to a version the workflow
//   published; anyone else is told the workflow doesn't exist.
// - "latest": a binding names a publication number; a new version of the
//   workflow changes no binding. Moving to it is a new binding, audited.
// - A binding removed under a start: the start's admitting statement
//   requires the binding still active, as it requires the grant.
// - Deleting a workflow an App relies on: an active binding whose App
//   holds `start` on it keeps it from being deleted (workflow-resources.ts).
//   One whose App can't start it pins nothing, and the workflow's builders
//   may remove any binding to it, so no builder of some App keeps a
//   workflow alive by binding it.
// - Grasp staff deciding what a client's App runs: they never bind or
//   remove a binding (`role.forbidden`).
// - A binding that changes what the App's pages name under it: the App
//   declares the events it sends, the listen tasks waiting on them and
//   the decisions it answers (`permission.workflow`), and its references
//   name them. Binding a version whose events, decisions or listen tasks
//   differ from what the App's current version declares is refused
//   (`workflow.app_binding_contract_changed`): the builder binds it from
//   the App's draft instead (app-definition.ts, `bindWorkflow`), which
//   writes the version's contract into the declaration and records the
//   version in the App's definition, to be bound with it (below). A
//   version with the same contract binds directly as any other.
//
// A binding recorded with an App version (`workflowBindings` in its
// definition) is bound as that version is made current, in the batch that
// makes it current (apps.ts, `makeCurrent`), never before: so the App's
// declaration and what its alias binds change together. Its release
// seals the version too (bound-workflows.ts, `sealedWorkflowPins`), so
// its pages read the runs of the version its starts run. How each way it
// can fail is closed (`versionBindingChanges`):
//
// - A recorded binding written by hand: a definition committed through
//   `files.commit` is checked for its shape only, so a version records a
//   binding its parent doesn't only if whoever commits it may bind it, as
//   `bindWorkflow` asks (`requireRecordableBindings`); no one launders one
//   into another builder's next version, which carries it over. Even so,
//   nothing it names is bound unless it holds as the version is made
//   current: the workflow is live and published that version, its
//   contract is the one the App version declares, the person making the
//   version current has a role in it, and so has the version's author for
//   a binding the version recorded of its own. Grasp staff never make a
//   version current that binds one.
// - Whoever bound it lost their role in the workflow before it is made
//   current: refused, the whole switch with it
//   (`workflow.app_version_binding_unavailable`), as is a version made
//   current by someone without one. The author answers for what their
//   version records unlike its parent; a binding a later version only
//   carries over binds on the authority of whoever makes that one
//   current, who must have a role in it too.
// - The workflow deleted, the App version unpublished, or the alias
//   rebound directly, as the switch lands: the switch's own statement
//   requires each workflow version it binds live, each alias still binding
//   what it was checked against, and the App version published, and binds
//   only if the switch landed, so both land or neither. A batch tried
//   again after one that landed binds nothing twice.
// - The contract changed between the draft and the switch (a declaration
//   committed by hand, a catalog contract the version no longer resolves):
//   each workflow version the release seals, and the binding an alias it
//   declares keeps where it seals none, is compared with what it declares
//   as the switch is checked (`workflow.app_binding_contract_changed`).
//   The roles are checked again once its schema applied, right before
//   the batch.
// - A rollback: making an older version current binds what its release
//   sealed, checked as above, so its pages and its starts name the same
//   versions again.
// - A later version undoing a rebind it never made: a version binds as
//   its own only what it records differently from the version people use
//   as it is sealed; for every other alias its release seals what the App
//   binds then, so a direct rebind made before it is sealed stays. One
//   made after it is sealed stays too, while its contract is the one the
//   version declares, and so does an unbinding (a workflow deleted
//   since, say): the switch binds such a pin again only over a version
//   of another contract (a rollback across a contract change), so pages
//   and starts agree on the contract, if not on the very version, as
//   after any direct rebind. What the version records unlike the version
//   current as it is made current is always bound.
//
// What an alias binds is otherwise the App's configuration, set by its
// builders and an admin's grant, like a workflow's parameters. The
// admin's `start` grant covers every version of the workflow, so a
// rebinding widens nothing a grant didn't.

const bindingOf = (
  row: typeof appWorkflowBindings.$inferSelect
): AppWorkflowBinding => ({
  id: row.id,
  app: row.appId,
  alias: row.alias,
  workflowId: row.workflowResourceId,
  version: row.workflowResourceVersion,
  boundBy: row.boundBy,
  boundAt: row.boundAt.toISOString(),
});

const invalid = () =>
  workflowResourceErrors.create("workflow.app_binding_invalid");

/**
 * Workflow `id`, for `by`, who must have a role in it, which published
 * version `version` (`workflow.app_binding_invalid` otherwise); anyone
 * else is told the workflow doesn't exist.
 */
const bindableVersion = async (
  env: Env,
  by: Acting,
  id: unknown,
  version: number
): Promise<{ readonly id: string }> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const published = await drizzle(env.DB)
    .select({ version: workflowResourceVersions.version })
    .from(workflowResourceVersions)
    .where(
      and(
        eq(workflowResourceVersions.workflowResourceId, workflow.id),
        eq(workflowResourceVersions.version, version)
      )
    )
    .get();
  if (published === undefined) {
    throw invalid();
  }
  return workflow;
};

/**
 * The events, listen tasks and decisions version `version` of workflow
 * `id` has, for `by`, who may bind it (`bindableVersion`), and that
 * version: what a draft declares and records when they bind it there
 * (`bindWorkflow`, agent-builds.ts).
 */
export const bindableContract = async (
  env: Env,
  by: Acting,
  id: unknown,
  version: number
): Promise<{
  contract: WorkflowEventContract;
  bound: { workflowId: string; version: number };
}> => {
  requireNotStaff(by);
  const workflow = await bindableVersion(env, by, id, version);
  const { complete, ...contract } = await versionEventContract(
    env,
    workflow.id,
    version
  );
  // Never part of a contract: a draft declares all of it or nothing.
  if (!complete) {
    throw invalid();
  }
  return { contract, bound: { workflowId: workflow.id, version } };
};

/**
 * Why a draft can't bind `bound` under `alias` of App `app`, or undefined
 * when it can: the version people use (`before`, its definition) records
 * that binding already, while the App binds another there now (a direct
 * rebind since). A version binds only what it records differently from
 * that version (bound-workflows.ts, `sealedWorkflowPins`), so recording
 * the same again would bind nothing: it is bound directly instead, as its
 * contract is the one the App declares.
 */
export const carriedOverBinding = async (
  env: Env,
  app: AppId,
  before: AppDefinition | null,
  alias: string,
  bound: { readonly workflowId: string; readonly version: number }
): Promise<string | undefined> => {
  const recorded = (before?.workflowBindings ?? []).some(
    (held) =>
      held.alias === alias &&
      held.workflowId === bound.workflowId &&
      held.version === bound.version
  );
  if (!recorded) {
    return undefined;
  }
  const active = await drizzle(env.DB)
    .select({
      workflowId: appWorkflowBindings.workflowResourceId,
      version: appWorkflowBindings.workflowResourceVersion,
    })
    .from(appWorkflowBindings)
    .where(
      and(
        eq(appWorkflowBindings.appId, app),
        eq(appWorkflowBindings.alias, alias),
        eq(appWorkflowBindings.status, "active")
      )
    )
    .get();
  return active?.workflowId === bound.workflowId &&
    active.version === bound.version
    ? undefined
    : `The App's current version binds version ${bound.version} as \`${alias}\` already, and \`${alias}\` was bound to another version, or unbound, directly since. Bind version ${bound.version} directly, as \`env.workflowBuild.bind\` does: its contract is the one the App declares.`;
};

/**
 * That version `version` of workflow `workflow` has the events, decisions
 * and listen tasks App `app`'s current version declares under `alias`
 * (`workflow.app_binding_contract_changed` otherwise). Nothing to hold to
 * for an App with no current version, or one that doesn't declare the
 * alias: what its draft declares is written from the version it binds.
 */
const requireDeclaredContract = async (
  env: Env,
  app: App,
  alias: string,
  workflow: string,
  version: number
): Promise<void> => {
  if (app.currentVersion === null) {
    return;
  }
  const release = await loadRelease(env, app.id, app.currentVersion);
  const declared = declaredPermission(release.app, alias, "workflows");
  if (declared === undefined) {
    return;
  }
  // All of it, or the App could rely on part of a contract the version
  // no longer resolves.
  const bound = await versionEventContract(env, workflow, version);
  if (!bound.complete || !sameEventContract(declared, bound)) {
    throw workflowResourceErrors.create(
      "workflow.app_binding_contract_changed"
    );
  }
};

/**
 * Tells App `app`'s pages following its workflows to read them again
 * (app.ts, `workflowPolicyChanged`): a binding changed what each watch may
 * show and what its person may start (page-workflows.ts). Best effort:
 * the change stands if the App can't be reached, and its pages read
 * again at their runs' next change.
 */
export const tellBindingChanged = async (
  env: Env,
  app: string
): Promise<void> => {
  try {
    await appHost(env, appIdSchema.parse(app)).workflowPolicyChanged();
  } catch (error) {
    log.error("app.workflow_policy_tell_failed", {
      appId: app,
      ...errorFields(error),
    });
  }
};

/**
 * A binding making an App version current makes: the workflow version
 * its release sealed under `alias`, where the App binds another now.
 */
export interface BindingChange {
  readonly alias: string;
  readonly workflowId: string;
  readonly version: number;
  /** Who recorded it, when the App version recorded it: its author. */
  readonly recordedBy?: string;
  /** The active binding it replaces, if any. */
  readonly replacing?: {
    readonly id: string;
    readonly workflowId: string;
    readonly version: number;
  };
}

const unavailableToBind = () =>
  workflowResourceErrors.create("workflow.app_version_binding_unavailable");

/**
 * That `who` may bind version `version` of workflow `workflow` as a
 * builder binds it (`bindableVersion`): refused as
 * `workflow.app_version_binding_unavailable`, as for no one.
 */
const requireMayBind = async (
  env: Env,
  who: Acting | undefined,
  { workflowId, version }: Pick<BindingChange, "workflowId" | "version">
): Promise<void> => {
  if (who === undefined) {
    throw unavailableToBind();
  }
  try {
    await bindableVersion(env, who, workflowId, version);
  } catch (error) {
    if (isExpectedError(error)) {
      throw unavailableToBind();
    }
    throw error;
  }
};

/**
 * The bindings `definition` records that `parent` (the definition of the
 * version it is committed over, none for an App's first) doesn't: what
 * the version binds of its own, which its author answers for.
 */
export const ownWorkflowBindings = (
  definition: AppDefinition,
  parent: AppDefinition | null
): DefinedWorkflowBinding[] =>
  (definition.workflowBindings ?? []).filter(
    (bound) =>
      !(parent?.workflowBindings ?? []).some(
        ({ alias, workflowId, version }) =>
          alias === bound.alias &&
          workflowId === bound.workflowId &&
          version === bound.version
      )
  );

/**
 * That `by`, committing `definition` over `parent`, may bind each
 * workflow version it records of its own (`ownWorkflowBindings`), as a
 * draft's `bindWorkflow` asks: so no one records, by committing a
 * definition by hand, a binding another builder would carry into a
 * version of theirs (`workflow.app_version_binding_unavailable`).
 */
export const requireRecordableBindings = async (
  env: Env,
  by: Acting,
  definition: AppDefinition,
  parent: AppDefinition | null
): Promise<void> => {
  const own = ownWorkflowBindings(definition, parent);
  if (own.length > 0) {
    requireNotStaff(by);
  }
  for (const bound of own) {
    // oxlint-disable-next-line no-await-in-loop -- a few, one at a time
    await requireMayBind(env, by, bound);
  }
};

/**
 * That `by` may make each of `changes`, and `author`, read now, each the
 * version recorded of its own: a former member binds nothing, and Grasp
 * staff none (`role.forbidden`).
 */
const requireMayMake = async (
  env: Env,
  by: Acting,
  author: string,
  changes: readonly BindingChange[]
): Promise<void> => {
  if (changes.length > 0) {
    requireNotStaff(by);
  }
  const authorNow = changes.some(({ recordedBy }) => recordedBy !== undefined)
    ? await memberOf(env.DB, author)
    : undefined;
  for (const change of changes) {
    // oxlint-disable-next-line no-await-in-loop -- a few, one at a time
    await requireMayBind(env, by, change);
    if (change.recordedBy !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- as above
      await requireMayBind(env, authorNow, change);
    }
  }
};

/**
 * What making an App version current does to its workflow bindings: the
 * bindings it makes (`changes`), and what every alias it declares binds
 * as it was checked (`held`, an active binding's ID, or none), which the
 * switch requires still so.
 */
export interface BindingSwitch {
  readonly changes: readonly BindingChange[];
  readonly held: readonly { readonly alias: string; readonly id?: string }[];
}

/**
 * What making an App version current binds (see the header), for `by`:
 * each workflow version its release (`release`) seals where App `app`
 * binds another now. Each it binds must be one `by` may bind, and, for one
 * the version recorded (`recorded`, from its definition), one its author
 * (`author`) still may (`workflow.app_version_binding_unavailable`
 * otherwise); Grasp staff bind none (`role.forbidden`). Then what
 * every alias it declares binds once it is current, sealed or bound now,
 * must have the contract it declares
 * (`workflow.app_binding_contract_changed` otherwise).
 */
export const versionBindingChanges = async (
  env: Env,
  by: Acting,
  app: AppId,
  {
    author,
    recorded,
    chosen,
  }: {
    readonly author: string;
    /** What it records unlike its parent: what its author answers for. */
    readonly recorded: readonly DefinedWorkflowBinding[];
    /** What it records unlike the version current now: never kept over. */
    readonly chosen: readonly DefinedWorkflowBinding[];
  },
  release: Pick<Release, "app" | "workflows">
): Promise<BindingSwitch> => {
  const active = await drizzle(env.DB)
    .select({
      id: appWorkflowBindings.id,
      alias: appWorkflowBindings.alias,
      workflowId: appWorkflowBindings.workflowResourceId,
      version: appWorkflowBindings.workflowResourceVersion,
    })
    .from(appWorkflowBindings)
    .where(
      and(
        eq(appWorkflowBindings.appId, app),
        eq(appWorkflowBindings.status, "active")
      )
    );
  const declared = declaredPermissions(release.app, "workflows");
  /** Whether version `bound` has the contract the App declares as `alias`. */
  const fits = async (
    alias: string,
    bound: { readonly workflowId: string; readonly version: number }
  ): Promise<boolean> => {
    const declaration = declared.find((each) => each.alias === alias);
    const contract = await versionEventContract(
      env,
      bound.workflowId,
      bound.version
    );
    return (
      declaration !== undefined &&
      contract.complete &&
      sameEventContract(declaration, contract)
    );
  };
  const changes: BindingChange[] = [];
  /** The aliases left unbound: their pins carried, nothing bound now. */
  const left = new Set<string>();
  for (const { alias, pinned } of release.workflows) {
    const held = active.find((binding) => binding.alias === alias);
    if (
      held?.workflowId === pinned.workflowId &&
      held.version === pinned.version
    ) {
      continue;
    }
    const names = (bound: DefinedWorkflowBinding) =>
      bound.alias === alias &&
      bound.workflowId === pinned.workflowId &&
      bound.version === pinned.version;
    const recordedBy = recorded.some(names) ? author : undefined;
    // A pin the version only took from the App's binding as it was
    // sealed: a direct rebind of the same contract since stays, and so
    // does an unbinding (a workflow deleted since, say), which leaves
    // nothing bound to its contract.
    if (!chosen.some(names)) {
      if (held === undefined) {
        left.add(alias);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- a few, one at a time
      if (await fits(alias, held)) {
        continue;
      }
    }
    changes.push({
      alias,
      ...pinned,
      ...(recordedBy === undefined ? {} : { recordedBy }),
      ...(held === undefined
        ? {}
        : {
            replacing: {
              id: held.id,
              workflowId: held.workflowId,
              version: held.version,
            },
          }),
    });
  }
  await requireMayMake(env, by, author, changes);
  for (const { alias } of declared) {
    // What its release seals, which its pages read runs of, otherwise
    // what the App binds now, which the switch leaves; one it keeps over
    // a sealed pin fits already.
    const bound = left.has(alias)
      ? undefined
      : (release.workflows.find((pin) => pin.alias === alias)?.pinned ??
        active.find((binding) => binding.alias === alias));
    // oxlint-disable-next-line no-await-in-loop -- a few, one at a time
    if (bound !== undefined && !(await fits(alias, bound))) {
      throw workflowResourceErrors.create(
        "workflow.app_binding_contract_changed"
      );
    }
  }
  return {
    changes,
    held: declared.map(({ alias }) => {
      const id = active.find((binding) => binding.alias === alias)?.id;
      return id === undefined ? { alias } : { alias, id };
    }),
  };
};

/** That `alias` of App `app` binds `id` now, or nothing for none, as SQL. */
const heldSql = (app: AppId, alias: string, id?: string): SQL =>
  id === undefined
    ? sql`NOT EXISTS (SELECT 1 FROM app_workflow_bindings AS held
        WHERE held.app_id = ${app} AND held.alias = ${alias}
          AND held.status = 'active')`
    : sql`EXISTS (SELECT 1 FROM app_workflow_bindings AS held
        WHERE held.id = ${id} AND held.app_id = ${app}
          AND held.alias = ${alias} AND held.status = 'active')`;

/**
 * That the switch `checked` still holds, as SQL: what the statement making
 * the App version current requires, so a deletion or a direct rebind
 * landing first refuses the whole switch. Each workflow version it binds
 * is live and published, and each alias it declares still binds what it
 * was checked against. Each list is one JSON value, so an App declaring
 * many workflows stays within the values D1 binds to one statement.
 */
export const bindableSql = (app: AppId, checked: BindingSwitch): SQL => {
  const binds = JSON.stringify(
    checked.changes.map(({ workflowId, version }) => [workflowId, version])
  );
  const held = JSON.stringify(
    checked.held.map(({ alias, id }) => [alias, id ?? null])
  );
  return sql`NOT EXISTS (SELECT 1 FROM json_each(${binds}) AS bind
      WHERE NOT EXISTS (SELECT 1 FROM workflow_resource_versions AS bound
        JOIN workflow_resources AS live ON live.id = bound.workflow_resource_id
        WHERE live.id = bind.value ->> 0 AND live.deleted_at IS NULL
          AND bound.version = bind.value ->> 1))
    AND NOT EXISTS (SELECT 1 FROM json_each(${held}) AS checked
      WHERE (SELECT held.id FROM app_workflow_bindings AS held
        WHERE held.app_id = ${app} AND held.alias = checked.value ->> 0
          AND held.status = 'active') IS NOT checked.value ->> 1)`;
};

/**
 * The statements binding `changes` as version `appVersion` of App `app`
 * is made current by `by`, each only if `landed` holds as it runs (the
 * switch's event was stored): each replaces the binding its alias was
 * checked against, audited with the App version it came with and who
 * recorded it. Once only: a batch tried again after one that landed finds
 * the alias binding another, and changes nothing.
 */
export const bindingChangeStatements = (
  env: Env,
  by: Acting,
  {
    app,
    appVersion,
    switchId,
  }: {
    readonly app: AppId;
    readonly appVersion: number;
    /** The switch's event: one binding per alias and switch, ever. */
    readonly switchId: string;
  },
  changes: readonly BindingChange[],
  landed: SQL
): BatchItem<"sqlite">[] => {
  const db = drizzle(env.DB);
  const now = new Date();
  return changes.flatMap((change) => {
    // The same on every try of the batch, so a try after one that landed
    // binds nothing, whatever changed in between.
    const id = `${switchId}:${change.alias}`;
    const replacing = change.replacing?.id;
    return [
      db
        .update(appWorkflowBindings)
        .set({ status: "removed", removedBy: by.userId, removedAt: now })
        .where(
          and(
            eq(appWorkflowBindings.id, replacing ?? ""),
            eq(appWorkflowBindings.status, "active"),
            landed
          )
        ),
      // Only once the alias binds nothing: the binding it was checked
      // against removed just above, or none there to begin with.
      db.insert(appWorkflowBindings).select(
        sql`SELECT ${id}, ${app}, ${change.alias}, ${change.workflowId}, ${change.version}, 'active', ${by.userId}, ${now.getTime()}, NULL, NULL
            WHERE ${landed} AND ${heldSql(app, change.alias)}
              AND NOT EXISTS (SELECT 1 FROM app_workflow_bindings WHERE id = ${id})`
      ),
      outboxedWhere(
        db,
        {
          actor: by.actor ?? actorOf(by),
          action: "workflow.app_binding.bound",
          target: { type: "app", id: app },
          detail: {
            binding: id,
            alias: change.alias,
            workflowId: change.workflowId,
            version: change.version,
            appVersion,
            recordedBy: change.recordedBy ?? null,
            replacedBinding: replacing ?? null,
            replacedWorkflowId: change.replacing?.workflowId ?? null,
            replacedVersion: change.replacing?.version ?? null,
          },
        },
        // Only by the try that inserted it.
        sql`changes() > 0`
      ),
    ];
  });
};

/**
 * Binds version `input.version` of workflow `id` to App `input.app` under
 * `input.alias`, for `by`, who must build the App and have a role in the
 * workflow. Replaces the alias's earlier binding in the same batch.
 */
export const bindWorkflowToApp = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown,
  /** Admits the write, right before it commits: throws to write nothing. */
  admit?: () => Promise<void>
): Promise<AppWorkflowBinding> => {
  requireNotStaff(by);
  const { app, alias, version } = workflowResourceErrors.parse(
    "workflow.app_binding_invalid",
    appWorkflowBindingSchema,
    input
  );
  const found = await editableApp(env, by, app);
  const workflow = await bindableVersion(env, by, id, version);
  await requireDeclaredContract(env, found, alias, workflow.id, version);
  const row: typeof appWorkflowBindings.$inferSelect = {
    id: crypto.randomUUID(),
    appId: found.id,
    alias,
    workflowResourceId: workflow.id,
    workflowResourceVersion: version,
    status: "active",
    boundBy: by.userId,
    boundAt: new Date(),
    removedBy: null,
    removedAt: null,
  };
  const db = drizzle(env.DB);
  // The binding this one replaces, named in its event, so a rebind's
  // record says what ran before. Read here; should another rebind land
  // between this read and the batch, the batch's update still removes
  // whichever is active, and the event names the one read.
  const replacing = await db
    .select({
      id: appWorkflowBindings.id,
      workflowId: appWorkflowBindings.workflowResourceId,
      version: appWorkflowBindings.workflowResourceVersion,
    })
    .from(appWorkflowBindings)
    .where(
      and(
        eq(appWorkflowBindings.appId, found.id),
        eq(appWorkflowBindings.alias, alias),
        eq(appWorkflowBindings.status, "active")
      )
    )
    .get();
  // After every read: an agent whose permission was revoked meanwhile
  // binds nothing.
  await admit?.();
  try {
    await auditedBatch(env, db, [
      db
        .update(appWorkflowBindings)
        .set({
          status: "removed",
          removedBy: by.userId,
          removedAt: row.boundAt,
        })
        .where(
          and(
            eq(appWorkflowBindings.appId, found.id),
            eq(appWorkflowBindings.alias, alias),
            eq(appWorkflowBindings.status, "active")
          )
        ),
      db.insert(appWorkflowBindings).values({
        ...row,
        // Only while the App isn't archived, as the batch runs, and its
        // current version is still the one whose declaration the contract
        // was checked against: otherwise NULL, which fails the batch
        // (app-status.ts).
        appId: sql`(SELECT id FROM apps
          WHERE id = ${found.id} AND status != 'archived'
            AND current_version IS ${found.currentVersion})`,
        // Only while the workflow is live: otherwise NULL, which fails the
        // batch, so a deletion and this binding never both land.
        workflowResourceId: sql`(SELECT id FROM workflow_resources
          WHERE id = ${workflow.id} AND deleted_at IS NULL)`,
      }),
      outboxed(db, {
        actor: by.actor ?? actorOf(by),
        action: "workflow.app_binding.bound",
        target: { type: "app", id: found.id },
        detail: {
          binding: row.id,
          alias,
          workflowId: workflow.id,
          version,
          // Flat, as every event's detail is (`auditDetailValueSchema`):
          // null for a binding that replaces none.
          replacedBinding: replacing?.id ?? null,
          replacedWorkflowId: replacing?.workflowId ?? null,
          replacedVersion: replacing?.version ?? null,
        },
      }),
    ]);
  } catch (error) {
    if (notNullFailed(error, "app_workflow_bindings.app_id")) {
      // Archived, or another version made current since the check.
      const now = await appFor(env, by, found.id, "builder");
      throw now.status === "archived"
        ? appErrors.create("app.archived")
        : workflowResourceErrors.create("workflow.binding_conflict");
    }
    if (notNullFailed(error, "app_workflow_bindings.workflow_resource_id")) {
      throw workflowResourceErrors.create("workflow.resource_unavailable");
    }
    if (isUniqueViolation(error)) {
      throw workflowResourceErrors.create("workflow.binding_conflict");
    }
    throw error;
  }
  await tellBindingChanged(env, found.id);
  return bindingOf(row);
};

/**
 * Whether `by` may remove `row`: they build its App, or the workflow it
 * binds, whose deletion it may hold up.
 */
const mayRemove = async (
  env: Env,
  by: Acting,
  row: typeof appWorkflowBindings.$inferSelect
): Promise<boolean> => {
  for (const check of [
    async () => await editableApp(env, by, row.appId),
    async () =>
      await requireWorkflowRole(env, by, row.workflowResourceId, "builder"),
  ]) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- the second only if the first refuses
      await check();
      return true;
    } catch (error) {
      if (!isExpectedError(error)) {
        throw error;
      }
    }
  }
  return false;
};

/**
 * Removes App binding `binding`, for `by`, who must build its App or the
 * workflow it binds, and isn't Grasp staff; anyone else is told there is
 * no such binding.
 */
export const unbindWorkflowFromApp = async (
  env: Env,
  by: Acting,
  binding: unknown
): Promise<void> => {
  requireNotStaff(by);
  if (typeof binding !== "string") {
    throw workflowResourceErrors.create("workflow.app_binding_unavailable");
  }
  const row = await drizzle(env.DB)
    .select()
    .from(appWorkflowBindings)
    .where(
      and(
        eq(appWorkflowBindings.id, binding),
        eq(appWorkflowBindings.status, "active")
      )
    )
    .get();
  if (row === undefined) {
    throw workflowResourceErrors.create("workflow.app_binding_unavailable");
  }
  if (!(await mayRemove(env, by, row))) {
    throw workflowResourceErrors.create("workflow.app_binding_unavailable");
  }
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(appWorkflowBindings)
      .set({ status: "removed", removedBy: by.userId, removedAt: new Date() })
      .where(
        and(
          eq(appWorkflowBindings.id, row.id),
          eq(appWorkflowBindings.status, "active")
        )
      ),
    outboxedIfChanged(db, {
      actor: by.actor ?? actorOf(by),
      action: "workflow.app_binding.removed",
      target: { type: "app", id: row.appId },
      detail: {
        binding: row.id,
        alias: row.alias,
        workflowId: row.workflowResourceId,
        version: row.workflowResourceVersion,
      },
    }),
  ]);
  await tellBindingChanged(env, row.appId);
};

/**
 * The active bindings of App `app`, by alias, for `by`, who must build it
 * and isn't Grasp staff, as for binding and removing one. An archived
 * App's are listed too: it keeps them for when it is restored.
 */
export const listAppWorkflowBindings = async (
  env: Env,
  by: Acting,
  app: unknown
): Promise<AppWorkflowBinding[]> => {
  requireNotStaff(by);
  const found = await appFor(env, by, app, "builder");
  const rows = await drizzle(env.DB)
    .select()
    .from(appWorkflowBindings)
    .where(
      and(
        eq(appWorkflowBindings.appId, found.id),
        eq(appWorkflowBindings.status, "active")
      )
    )
    .orderBy(asc(appWorkflowBindings.alias));
  return rows.map(bindingOf);
};

/**
 * Starts the workflow version App code's `authority` binds under `alias`,
 * with `request` (its input and idempotency key): through the App's own
 * `start` permission, acting for the person its call acts for, and only
 * while the binding is still active as the start is admitted. Resolved
 * here, as it stands now: a binding is the App's configuration, not part
 * of the App version running (see above).
 */
export const startAppBinding = async (
  env: Env,
  authority: Authority,
  alias: unknown,
  request: unknown,
  /** What else the start's audit event names (the agent that had it made). */
  noted?: Readonly<Record<string, string>>,
  /**
   * What else must hold as the start is admitted, as SQL (the permission
   * of the agent that had it made), read by the admitting statement.
   */
  requires: SQL = sql`1`,
  /** Asked just before the start is admitted: throws to start nothing. */
  beforeAdmit?: () => void,
  /** The agent whose call made it, whose chat's restricted mode it takes. */
  agent: StartingAgent | null = null,
  /** The App files it may hand its run: a page's start's only (GRA-885). */
  files?: StartFiles
): Promise<WorkflowStart> => {
  if (authority.subject.type !== "app" || typeof alias !== "string") {
    throw workflowResourceErrors.create("workflow.app_binding_unavailable");
  }
  const { args, key } = workflowResourceErrors.parse(
    "workflow.start_invalid",
    workflowStartSchema.omit({ version: true }),
    request
  );
  const row = await drizzle(env.DB)
    .select()
    .from(appWorkflowBindings)
    .where(
      and(
        eq(appWorkflowBindings.appId, authority.subject.appId),
        eq(appWorkflowBindings.alias, alias),
        eq(appWorkflowBindings.status, "active")
      )
    )
    .get();
  if (row === undefined) {
    throw workflowResourceErrors.create("workflow.app_binding_unavailable");
  }
  return await startWorkflow(
    env,
    { type: "app", authority, agent },
    row.workflowResourceId,
    { version: row.workflowResourceVersion, args, key },
    sql`EXISTS (SELECT 1 FROM app_workflow_bindings
      WHERE id = ${row.id} AND status = 'active') AND ${requires}`,
    noted,
    beforeAdmit,
    files
  );
};

/**
 * That App `app`'s active binding of `alias` names exactly workflow
 * version `pin`, as SQL: what a page's run, and a run a mutation
 * notifies, are read through (page-workflows.ts,
 * workflow-notifications.ts).
 */
export const bindingPinnedSql = (
  app: AppId,
  alias: string,
  pin: { readonly workflowId: string; readonly version: number }
): SQL =>
  sql`EXISTS (SELECT 1 FROM app_workflow_bindings
    WHERE app_id = ${app} AND alias = ${alias} AND status = 'active'
      AND workflow_resource_id = ${pin.workflowId}
      AND workflow_resource_version = ${pin.version})`;
