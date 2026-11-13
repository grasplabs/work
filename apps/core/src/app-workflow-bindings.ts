import type {
  AppDefinition,
  DefinedWorkflowBinding,
} from "@grasp-os/runtime/definition";
import { contractGaps, declaredPermission } from "@grasp-os/runtime/host";
import type { WorkflowEventContract } from "@grasp-os/runtime/host";
import type { App } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Authority } from "@grasp-os/shared/permissions";
import {
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
import { appFor, findApp } from "./apps.ts";
import { outboxedWhere } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import { versionEventContract } from "./bound-workflows.ts";
import { appWorkflowBindings } from "./db/core/schema.ts";
import { appHost } from "./durable-objects.ts";
import { requireNotStaff } from "./sharing.ts";
import { liveWorkflow, requireWorkflowRole } from "./workflow-resources.ts";
import { startWorkflow } from "./workflow-starts.ts";
import type { StartingAgent } from "./workflow-starts.ts";
import type { StartFiles } from "./workflows/start-files.ts";

// Apps binding independent workflows (platform specification 3, 13.1,
// 15.1): an App names a workflow by an alias of its own, and its code
// starts the workflow's live version through the alias (a binding
// follows it; a run keeps the version it started on). The App never
// owns the workflow nor gains its grants. A binding is part of the App's
// version: a builder binds a workflow in the App's draft (`bindWorkflow`,
// agent-builds.ts), which declares what the App relies on of it and
// records the workflow in the draft's definition (`workflowBindings`),
// and publishing the draft binds it, in the batch that makes the version
// current (apps.ts, `activateVersion`); a version that binds nothing
// under an alias leaves nothing bound there. Threat model, and how each
// is closed:
//
// - Grouping or binding as a grant: a binding names a workflow and
//   nothing more. Starting through it still takes the App's own `start`
//   permission on the workflow, granted by an admin (workflow-starts.ts).
// - Binding a workflow you can't use: only someone who builds the App and
//   has a role in the workflow binds it in the draft, once it has a live
//   version; anyone else is told the workflow doesn't exist. A definition
//   written whole, by hand, is held to the same (`requireRecordableBindings`,
//   as its version is committed), and whoever makes a version current
//   must have a role in each workflow it binds anew (`requireMayBind`), a
//   roll back's included: its author may have left the workflow, or the
//   company, since. Grasp staff bind nothing (`role.forbidden`).
// - A new version breaking the App: the App declares the events it
//   sends, the listen tasks waiting on them and the decisions it answers
//   (`permission.workflow`), and its references name them. A workflow
//   version goes live only if it gives everything each App binding it
//   declares (`requireBoundAppsDeclare`, workflow-publish.ts), whatever
//   else it has, and an App version is made current only if the live
//   version of each workflow it binds gives everything it declares
//   (`versionBindingChanges`), each refusal naming the App and what it
//   still uses (`workflow.app_binding_contract_changed`). So a workflow
//   adds to its contract at once and an App declares the addition after;
//   it drops something only once no App it is bound to declares it. Each
//   side's batch requires what it checked still so: an App's switch the
//   live version of each workflow it was checked against, a workflow's
//   publish or roll back each bound App's current version, so of an App's
//   and a workflow's change at once, the one landing second is refused.
// - A binding removed under a start: the start's admitting statement
//   requires the binding still active, as it requires the grant.
// - Deleting a workflow an App relies on: an active binding whose App
//   holds `start` on it keeps it from being deleted (workflow-resources.ts),
//   until the App's builders publish a version that doesn't bind it. One
//   whose App can't start it holds nothing, so no builder of some App
//   keeps a workflow alive by binding it.
// - The workflow deleted, or a workflow's version made live, as the
//   switch lands: the switch's own statement requires each workflow it
//   binds live at the version checked, each alias still binding what it
//   was checked against, and the App version published, and binds only
//   if the switch landed, so both land or neither. A batch tried again
//   after one that landed binds nothing twice.
// - A rollback: making an older version current binds what its release
//   sealed, checked as above, so its pages and its starts name the same
//   workflows again.
//
// The admin's `start` grant covers every version of the workflow, so a
// rebinding widens nothing a grant didn't.

const bindingOf = (
  row: typeof appWorkflowBindings.$inferSelect
): AppWorkflowBinding => ({
  id: row.id,
  app: row.appId,
  alias: row.alias,
  workflowId: row.workflowResourceId,
  boundBy: row.boundBy,
  boundAt: row.boundAt.toISOString(),
});

const invalid = () =>
  workflowResourceErrors.create("workflow.app_binding_invalid");

/**
 * Workflow `id`, for `by`, who must have a role in it, and its live
 * version, which its App bindings start (`workflow.app_binding_invalid`
 * while it has none); anyone else is told the workflow doesn't exist.
 */
const bindableWorkflow = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<{ readonly id: string; readonly version: number }> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  if (workflow.currentVersion === null) {
    throw invalid();
  }
  return { id: workflow.id, version: workflow.currentVersion };
};

/**
 * The events, listen tasks and decisions the live version of workflow
 * `id` has, for `by`, who may bind it (`bindableWorkflow`), and the
 * workflow: what a draft declares and records when they bind it there
 * (`bindWorkflow`, agent-builds.ts).
 */
export const bindableContract = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<{
  contract: WorkflowEventContract;
  bound: { workflowId: string };
}> => {
  requireNotStaff(by);
  const workflow = await bindableWorkflow(env, by, id);
  const { complete, ...contract } = await versionEventContract(
    env,
    workflow.id,
    workflow.version
  );
  // Never part of a contract: a draft declares all of it or nothing.
  if (!complete) {
    throw invalid();
  }
  return { contract, bound: { workflowId: workflow.id } };
};

/** An App that relies on what a workflow version doesn't give: what, by name. */
interface ContractUse {
  readonly app: string;
  readonly name: string;
  readonly uses: readonly string[];
}

/**
 * The refusal of a change that would leave an App relying on what its
 * workflow's live version doesn't give (`contractGaps`), naming each App
 * and what it still uses, with how to go on (`next`).
 */
const contractRefusal = (uses: readonly ContractUse[], next: string) =>
  Object.assign(
    workflowResourceErrors.create("workflow.app_binding_contract_changed", {
      apps: uses.map(({ app, name, uses: items }) => ({
        id: app,
        name,
        uses: [...items],
      })),
    }),
    {
      message: `${uses
        .map(({ name, uses: items }) => `${name} uses ${items.join(", ")}`)
        .join("; ")}, which the workflow's live version wouldn't have. ${next}`,
    }
  );

/**
 * That every App binding workflow `workflow` declares nothing its
 * version `version` doesn't give (`contractGaps`): what it has besides
 * is no App's concern. A binding follows its workflow's live version, so
 * a version that drops what an App's pages name never goes live,
 * refused naming each such App and what it uses
 * (`workflow.app_binding_contract_changed`; workflow-publish.ts).
 * Answers what the batch making the version live requires still holds,
 * as SQL: the same Apps bound, each at the current version checked, so
 * an App bound or published since refuses the whole batch.
 */
export const requireBoundAppsDeclare = async (
  env: Env,
  workflow: string,
  version: number
): Promise<SQL> => {
  const bound = await drizzle(env.DB)
    .select({
      id: appWorkflowBindings.id,
      app: appWorkflowBindings.appId,
      alias: appWorkflowBindings.alias,
    })
    .from(appWorkflowBindings)
    .where(
      and(
        eq(appWorkflowBindings.workflowResourceId, workflow),
        eq(appWorkflowBindings.status, "active")
      )
    )
    .all();
  const checked: [string, number | null][] = [];
  const uses: ContractUse[] = [];
  const provided =
    bound.length === 0
      ? undefined
      : await versionEventContract(env, workflow, version);
  for (const { id, app, alias } of bound) {
    // oxlint-disable-next-line no-await-in-loop -- a few, one at a time
    const found = await findApp(env, app);
    checked.push([id, found.currentVersion]);
    // An App binds only from a current version; one with none declares
    // nothing yet.
    if (found.currentVersion === null || provided === undefined) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    const release = await loadRelease(env, found.id, found.currentVersion);
    const declared = declaredPermission(release.app, alias, "workflows");
    const gaps = declared === undefined ? [] : contractGaps(declared, provided);
    if (gaps.length > 0) {
      uses.push({ app: found.id, name: found.name, uses: gaps });
    }
  }
  if (uses.length > 0) {
    throw contractRefusal(
      uses,
      "Bind the workflow again in each App's draft, declaring only what this version has, and publish them first."
    );
  }
  // One JSON value, so a workflow many Apps bind stays within the values
  // D1 binds to one statement.
  return sql`NOT EXISTS (SELECT 1 FROM app_workflow_bindings AS bound
      JOIN apps AS app ON app.id = bound.app_id
    WHERE bound.workflow_resource_id = ${workflow} AND bound.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM json_each(${JSON.stringify(checked)}) AS checked
        WHERE checked.value ->> 0 = bound.id
          AND app.current_version IS checked.value ->> 1))`;
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

/** An active binding of an App's, as a switch reads it. */
interface HeldBinding {
  readonly id: string;
  readonly alias: string;
  readonly workflowId: string;
  readonly version: number;
}

/**
 * A binding making an App version current makes: the workflow its
 * release seals under `alias`, where the App binds another now or none,
 * and its live version as checked, which the binding records it was made
 * at.
 */
export interface BindingChange {
  readonly alias: string;
  readonly workflowId: string;
  readonly version: number;
  /** The active binding it replaces, if any. */
  readonly replacing?: HeldBinding;
}

const unavailableToBind = () =>
  workflowResourceErrors.create("workflow.app_version_binding_unavailable");

/**
 * That `who` may bind workflow `workflowId` as a builder binds it
 * (`bindableWorkflow`): refused as
 * `workflow.app_version_binding_unavailable`.
 */
const requireMayBind = async (
  env: Env,
  who: Acting,
  workflowId: string
): Promise<void> => {
  try {
    await bindableWorkflow(env, who, workflowId);
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
 * the version binds anew.
 */
const ownWorkflowBindings = (
  definition: AppDefinition,
  parent: AppDefinition | null
): DefinedWorkflowBinding[] =>
  (definition.workflowBindings ?? []).filter(
    (bound) =>
      !(parent?.workflowBindings ?? []).some(
        ({ alias, workflowId }) =>
          alias === bound.alias && workflowId === bound.workflowId
      )
  );

/**
 * That `by`, committing `definition` over `parent`, may bind each
 * workflow it records anew (`ownWorkflowBindings`), as a draft's
 * `bindWorkflow` asks: so no one records, in a definition written whole,
 * a binding of a workflow they have no role in
 * (`workflow.app_version_binding_unavailable`).
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
  for (const { workflowId } of own) {
    // oxlint-disable-next-line no-await-in-loop -- a few, one at a time
    await requireMayBind(env, by, workflowId);
  }
};

/**
 * What making an App version current does to its workflow bindings: the
 * bindings it makes (`changes`) and ends (`removals`, an alias its
 * release seals nothing under), what every alias it touches binds as it
 * was checked (`held`, an active binding's ID, or none), and the live
 * version of each workflow its declaration was checked against (`live`),
 * which the switch requires still so.
 */
export interface BindingSwitch {
  readonly changes: readonly BindingChange[];
  readonly removals: readonly HeldBinding[];
  readonly held: readonly { readonly alias: string; readonly id?: string }[];
  readonly live: readonly {
    readonly workflowId: string;
    readonly version: number | null;
  }[];
}

/**
 * What making an App version current binds (see the header), for `by`:
 * each workflow its release (`release`) seals where App `app` binds
 * another now or none, at its live version, `by` holding a role in it
 * (`workflow.app_version_binding_unavailable` otherwise, and for a
 * workflow deleted since); and the end of each binding under an alias it
 * seals nothing under. Grasp staff change none (`role.forbidden`). The
 * live version of each workflow it binds must give everything the App
 * version declares of it (`workflow.app_binding_contract_changed`,
 * naming what it lacks).
 */
export const versionBindingChanges = async (
  env: Env,
  by: Acting,
  app: Pick<App, "id" | "name">,
  release: Pick<Release, "app" | "workflows">
): Promise<BindingSwitch> => {
  const active: HeldBinding[] = await drizzle(env.DB)
    .select({
      id: appWorkflowBindings.id,
      alias: appWorkflowBindings.alias,
      workflowId: appWorkflowBindings.workflowResourceId,
      version: appWorkflowBindings.workflowResourceVersion,
    })
    .from(appWorkflowBindings)
    .where(
      and(
        eq(appWorkflowBindings.appId, app.id),
        eq(appWorkflowBindings.status, "active")
      )
    );
  const changes: BindingChange[] = [];
  const live: BindingSwitch["live"][number][] = [];
  const uses: string[] = [];
  for (const { alias, workflowId } of release.workflows) {
    // oxlint-disable-next-line no-await-in-loop -- a few, one at a time
    const workflow = await liveWorkflow(env, workflowId);
    const version = workflow?.currentVersion ?? null;
    if (workflow === undefined || version === null) {
      throw unavailableToBind();
    }
    live.push({ workflowId, version });
    const held = active.find((binding) => binding.alias === alias);
    if (held?.workflowId !== workflowId) {
      changes.push({
        alias,
        workflowId,
        version,
        ...(held === undefined ? {} : { replacing: held }),
      });
    }
    const declared = declaredPermission(release.app, alias, "workflows");
    if (declared !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- as above
      const provided = await versionEventContract(env, workflowId, version);
      for (const gap of contractGaps(declared, provided)) {
        uses.push(`${gap} of ${workflow.name}`);
      }
    }
  }
  if (uses.length > 0) {
    throw contractRefusal(
      [{ app: app.id, name: app.name, uses }],
      "Bind the workflow again in the App's draft, which declares what its live version has, then publish."
    );
  }
  const removals = active.filter(
    ({ alias }) => !release.workflows.some((sealed) => sealed.alias === alias)
  );
  if (changes.length > 0 || removals.length > 0) {
    requireNotStaff(by);
  }
  for (const change of changes) {
    // oxlint-disable-next-line no-await-in-loop -- a few, one at a time
    await requireMayBind(env, by, change.workflowId);
  }
  const aliases = new Set([
    ...release.workflows.map(({ alias }) => alias),
    ...active.map(({ alias }) => alias),
  ]);
  return {
    changes,
    removals,
    held: [...aliases].map((alias) => {
      const id = active.find((binding) => binding.alias === alias)?.id;
      return id === undefined ? { alias } : { alias, id };
    }),
    live,
  };
};

/**
 * That the switch `checked` still holds, as SQL: what the statement making
 * the App version current requires, so a deletion or a workflow's publish
 * landing first refuses the whole switch. Each workflow it was checked
 * against is live at the version it was checked at, and each alias it
 * touches still binds what it was checked against. Each list is one JSON
 * value, so an App declaring many workflows stays within the values D1
 * binds to one statement.
 */
export const bindableSql = (app: AppId, checked: BindingSwitch): SQL => {
  const live = JSON.stringify(
    checked.live.map(({ workflowId, version }) => [workflowId, version])
  );
  const held = JSON.stringify(
    checked.held.map(({ alias, id }) => [alias, id ?? null])
  );
  return sql`NOT EXISTS (SELECT 1 FROM json_each(${live}) AS bind
      WHERE NOT EXISTS (SELECT 1 FROM workflow_resources AS live
        WHERE live.id = bind.value ->> 0 AND live.deleted_at IS NULL
          AND live.current_version IS bind.value ->> 1))
    AND NOT EXISTS (SELECT 1 FROM json_each(${held}) AS checked
      WHERE (SELECT held.id FROM app_workflow_bindings AS held
        WHERE held.app_id = ${app} AND held.alias = checked.value ->> 0
          AND held.status = 'active') IS NOT checked.value ->> 1)`;
};

/** That `alias` of App `app` binds nothing now, as SQL. */
const unboundSql = (app: AppId, alias: string): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM app_workflow_bindings AS held
    WHERE held.app_id = ${app} AND held.alias = ${alias}
      AND held.status = 'active')`;

/**
 * The statements making `checked`'s changes and removals as version
 * `appVersion` of App `app` is made current by `by`, each only if
 * `landed` holds as it runs (the switch's event was stored): each change
 * replaces the binding its alias was checked against, each removal ends
 * one, audited with the App version it came with. Once only: a batch
 * tried again after one that landed finds the alias binding another, or
 * none, and changes nothing.
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
  { changes, removals }: Pick<BindingSwitch, "changes" | "removals">,
  landed: SQL
): BatchItem<"sqlite">[] => {
  const db = drizzle(env.DB);
  const now = new Date();
  const actor = by.actor ?? actorOf(by);
  const ended = (binding: HeldBinding) =>
    db
      .update(appWorkflowBindings)
      .set({ status: "removed", removedBy: by.userId, removedAt: now })
      .where(
        and(
          eq(appWorkflowBindings.id, binding.id),
          eq(appWorkflowBindings.status, "active"),
          landed
        )
      );
  return [
    ...changes.flatMap((change) => {
      // The same on every try of the batch, so a try after one that landed
      // binds nothing, whatever changed in between.
      const id = `${switchId}:${change.alias}`;
      return [
        ...(change.replacing === undefined ? [] : [ended(change.replacing)]),
        // Only once the alias binds nothing: the binding it was checked
        // against ended just above, or none there to begin with.
        db.insert(appWorkflowBindings).select(
          sql`SELECT ${id}, ${app}, ${change.alias}, ${change.workflowId}, ${change.version}, 'active', ${by.userId}, ${now.getTime()}, NULL, NULL
              WHERE ${landed} AND ${unboundSql(app, change.alias)}
                AND NOT EXISTS (SELECT 1 FROM app_workflow_bindings WHERE id = ${id})`
        ),
        outboxedWhere(
          db,
          {
            actor,
            action: "workflow.app_binding.bound",
            target: { type: "app", id: app },
            detail: {
              binding: id,
              alias: change.alias,
              workflowId: change.workflowId,
              version: change.version,
              appVersion,
              replacedBinding: change.replacing?.id ?? null,
              replacedWorkflowId: change.replacing?.workflowId ?? null,
              replacedVersion: change.replacing?.version ?? null,
            },
          },
          // Only by the try that inserted it.
          sql`changes() > 0`
        ),
      ];
    }),
    ...removals.flatMap((binding) => [
      ended(binding),
      outboxedWhere(
        db,
        {
          actor,
          action: "workflow.app_binding.removed",
          target: { type: "app", id: app },
          detail: {
            binding: binding.id,
            alias: binding.alias,
            workflowId: binding.workflowId,
            version: binding.version,
            appVersion,
          },
        },
        // Only by the try that ended it.
        sql`changes() > 0`
      ),
    ]),
  ];
};

/**
 * The active bindings of App `app`, by alias, for `by`, who must build it
 * and isn't Grasp staff. An archived App's are listed too: it keeps them
 * for when it is restored.
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
 * Starts the live version of the workflow App code's `authority` binds
 * under `alias`,
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
    workflowStartSchema,
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
  // The workflow's live version as it is admitted: a binding follows it.
  return await startWorkflow(
    env,
    { type: "app", authority, agent },
    row.workflowResourceId,
    { args, key },
    sql`EXISTS (SELECT 1 FROM app_workflow_bindings
      WHERE id = ${row.id} AND status = 'active') AND ${requires}`,
    noted,
    beforeAdmit,
    files
  );
};

/**
 * That App `app`'s active binding of `alias` names workflow `workflowId`,
 * as SQL, whichever of its versions a run is of: a binding follows the
 * workflow's live version, and a run keeps the one it started on. What a
 * page's run, and a run a mutation sends an event, are read through
 * (page-workflows.ts, workflow-event-sends.ts).
 */
export const bindingNamesSql = (
  app: AppId,
  alias: string,
  workflowId: string
): SQL =>
  sql`EXISTS (SELECT 1 FROM app_workflow_bindings
    WHERE app_id = ${app} AND alias = ${alias} AND status = 'active'
      AND workflow_resource_id = ${workflowId})`;
