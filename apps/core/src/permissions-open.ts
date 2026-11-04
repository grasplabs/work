import { isExpectedError } from "@grasp-os/shared/errors";
import type { Permission } from "@grasp-os/shared/permissions";
import { isAdmin } from "@grasp-os/shared/roles";
import { drizzle } from "drizzle-orm/d1";

import { appsFoundBy, appsReadableBy } from "./app-access.ts";
import type { Member } from "./auth/identity.ts";
import { requireStoreManager } from "./data-stores.ts";
import { sdkStoreOwners, workflowResources } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { listPermissions } from "./permissions.ts";
import {
  requireTriggerManager,
  triggerSummaries,
} from "./trigger-resources.ts";
import { requireWorkflowRole } from "./workflow-resources.ts";

// The permissions a person may see: the one filter every reader of them
// goes by (the permissions API, a version's review), so none shows more
// than another.

/** Whether `check` lets `by` in: an expected refusal means it doesn't. */
const lets = async (check: () => Promise<unknown>): Promise<boolean> => {
  try {
    await check();
    return true;
  } catch (error) {
    if (isExpectedError(error)) {
      return false;
    }
    throw error;
  }
};

/** Who owns a store: an App, or a workflow (`sdk_store_owners`). */
type StoreOwner = { app: string } | { workflow: string };

/** The owner of each of `stores`, by store. */
const storeOwners = async (
  env: Env,
  stores: readonly string[]
): Promise<Map<string, StoreOwner>> => {
  if (stores.length === 0) {
    return new Map();
  }
  const rows = await drizzle(env.DB)
    .select({
      store: sdkStoreOwners.storeId,
      app: sdkStoreOwners.appId,
      workflow: sdkStoreOwners.workflowId,
    })
    .from(sdkStoreOwners)
    .where(inList(sdkStoreOwners.storeId, [...new Set(stores)]));
  return new Map(
    rows.flatMap(({ store, app, workflow }): [string, StoreOwner][] => {
      if (app !== null) {
        return [[store, { app }]];
      }
      return workflow === null ? [] : [[store, { workflow }]];
    })
  );
};

/** The App that owns store `store`, if an App does. */
const appOwning = (
  owners: ReadonlyMap<string, StoreOwner>,
  store: string
): string | undefined => {
  const owner = owners.get(store);
  return owner !== undefined && "app" in owner ? owner.app : undefined;
};

/** The workflow that owns store `store`, if a workflow does. */
const workflowOwning = (
  owners: ReadonlyMap<string, StoreOwner>,
  store: string
): string | undefined => {
  const owner = owners.get(store);
  return owner !== undefined && "workflow" in owner
    ? owner.workflow
    : undefined;
};

/** Each resource's answer, by its kind and ID, for one listing. */
type Answers = Map<string, Promise<boolean>>;

/**
 * Whether `by` may see the independent resources `permission` names (its
 * workflow, store or trigger subject; its workflow object, or the workflow
 * that owns its store object): an admin sees
 * every one; anyone else those they have a role in or manage, each as its
 * own registry decides it. Each resource is asked once per listing
 * (`answers`), however many of its permissions are listed, revoked ones
 * included.
 */
const resourcesOpen = async (
  env: Env,
  by: Member,
  { subject, object }: Permission,
  owningWorkflow: string | undefined,
  answers: Answers
): Promise<boolean> => {
  if (isAdmin(by.role)) {
    return true;
  }
  const asked = async (
    key: string,
    check: () => Promise<unknown>
  ): Promise<boolean> => {
    let answer = answers.get(key);
    if (answer === undefined) {
      answer = lets(check);
      answers.set(key, answer);
    }
    return await answer;
  };
  const checks: Promise<boolean>[] = [];
  if (subject.type === "workflow") {
    checks.push(
      asked(
        `workflow:${subject.workflowId}`,
        async () =>
          await requireWorkflowRole(env, by, subject.workflowId, "user")
      )
    );
  }
  if (subject.type === "store") {
    checks.push(
      asked(
        `store:${subject.storeId}`,
        async () => await requireStoreManager(env, by, subject.storeId)
      )
    );
  }
  if (subject.type === "trigger") {
    checks.push(
      asked(
        `trigger:${subject.triggerId}`,
        async () => await requireTriggerManager(env, by, subject.triggerId)
      )
    );
  }
  if (object.type === "workflow") {
    checks.push(
      asked(
        `workflow:${object.workflowId}`,
        async () =>
          await requireWorkflowRole(env, by, object.workflowId, "user")
      )
    );
  }
  if (owningWorkflow !== undefined) {
    checks.push(
      asked(
        `workflow:${owningWorkflow}`,
        async () => await requireWorkflowRole(env, by, owningWorkflow, "user")
      )
    );
  }
  const open = await Promise.all(checks);
  return open.every(Boolean);
};

/** The names of independent workflows `ids`, by ID. */
const namesOfWorkflows = async (
  env: Env,
  ids: readonly string[]
): Promise<Map<string, string>> => {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await drizzle(env.DB)
    .select({ id: workflowResources.id, name: workflowResources.name })
    .from(workflowResources)
    .where(inList(workflowResources.id, [...new Set(ids)]))
    .all();
  return new Map(rows.map(({ id, name }) => [id, name]));
};

/**
 * The permissions `by` may see, of `subject` and in `status` when given
 * (`listPermissions`): each naming only Apps they have a role in
 * (`appsFoundBy`) and may open now: one that read what they can't read
 * (`app.unreadable`) shows none of its permissions either. Each App named
 * is checked once. One naming an independent workflow, store or trigger
 * only if they have a role in it or manage it (`resourcesOpen`). One a
 * live trigger holds carries what the trigger is (`trigger`), and one on a
 * workflow that workflow's name (`workflowName`), so whoever decides it
 * knows which trigger asks and what it reaches.
 */
export const permissionsOpenTo = async (
  env: Env,
  by: Member,
  subject?: unknown,
  status?: unknown
): Promise<Permission[]> => {
  const listed = await listPermissions(
    env,
    by,
    subject,
    appsFoundBy(env, by),
    status
  );
  // A store object names the App or the workflow that owns it
  // (`listPermissions` lists only those whose App is open or whose
  // workflow is live): that App must be readable too, and that workflow
  // open to them (`resourcesOpen`).
  const owners = await storeOwners(
    env,
    listed.flatMap(({ object }) =>
      object.type === "store" ? [object.storeId] : []
    )
  );
  const named = listed.flatMap(({ subject: of, object }) => [
    ...(of.type === "app" ? [of.appId] : []),
    ...(object.type === "app" ? [object.appId] : []),
    ...(object.type === "store"
      ? [appOwning(owners, object.storeId) ?? ""]
      : []),
  ]);
  const readable = await appsReadableBy(
    env,
    by,
    [...new Set(named)].filter((app) => app !== "")
  );
  const open: Permission[] = [];
  const answers: Answers = new Map();
  for (const permission of listed) {
    const { subject: of, object } = permission;
    const ownedBy =
      object.type === "store"
        ? workflowOwning(owners, object.storeId)
        : undefined;
    const appsOpen =
      (of.type !== "app" || readable.has(of.appId)) &&
      (object.type !== "app" || readable.has(object.appId)) &&
      (object.type !== "store" ||
        ownedBy !== undefined ||
        readable.has(appOwning(owners, object.storeId) ?? ""));
    if (
      appsOpen &&
      // oxlint-disable-next-line no-await-in-loop -- each listed permission's own resources
      (await resourcesOpen(env, by, permission, ownedBy, answers))
    ) {
      open.push(permission);
    }
  }
  const [triggers, workflowNames] = await Promise.all([
    triggerSummaries(
      env,
      open.flatMap(({ subject: of }) =>
        of.type === "trigger" ? [of.triggerId] : []
      )
    ),
    namesOfWorkflows(
      env,
      open.flatMap(({ object }) =>
        object.type === "workflow" ? [object.workflowId] : []
      )
    ),
  ]);
  return open.map((permission) => {
    const { subject: of, object } = permission;
    const trigger =
      of.type === "trigger" ? triggers.get(of.triggerId) : undefined;
    const workflowName =
      object.type === "workflow"
        ? workflowNames.get(object.workflowId)
        : undefined;
    return {
      ...permission,
      ...(trigger === undefined ? {} : { trigger }),
      ...(workflowName === undefined ? {} : { workflowName }),
    };
  });
};
