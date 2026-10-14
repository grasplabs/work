import { isExpectedError } from "@grasp-os/shared/errors";
import type { Permission } from "@grasp-os/shared/permissions";
import { isAdmin } from "@grasp-os/shared/roles";

import { appsFoundBy, appsReadableBy } from "./app-access.ts";
import type { Member } from "./auth/identity.ts";
import { requireStoreManager } from "./data-stores.ts";
import { listPermissions } from "./permissions.ts";
import { requireTriggerManager } from "./trigger-resources.ts";
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

/**
 * Whether `by` may see the independent resources `permission` names (its
 * workflow, store or trigger subject; its workflow object): an admin sees
 * every one; anyone else those they have a role in or manage, each as its
 * own registry decides it.
 */
const resourcesOpen = async (
  env: Env,
  by: Member,
  { subject, object }: Permission
): Promise<boolean> => {
  if (isAdmin(by.role)) {
    return true;
  }
  const checks: (() => Promise<unknown>)[] = [];
  if (subject.type === "workflow") {
    checks.push(
      async () => await requireWorkflowRole(env, by, subject.workflowId, "user")
    );
  }
  if (subject.type === "store") {
    checks.push(
      async () => await requireStoreManager(env, by, subject.storeId)
    );
  }
  if (subject.type === "trigger") {
    checks.push(
      async () => await requireTriggerManager(env, by, subject.triggerId)
    );
  }
  if (object.type === "workflow") {
    checks.push(
      async () => await requireWorkflowRole(env, by, object.workflowId, "user")
    );
  }
  for (const check of checks) {
    // oxlint-disable-next-line no-await-in-loop -- at most two, each a point lookup
    if (!(await lets(check))) {
      return false;
    }
  }
  return true;
};

/**
 * The permissions `by` may see, of `subject` and in `status` when given
 * (`listPermissions`): each naming only Apps they have a role in
 * (`appsFoundBy`) and may open now: one that read what they can't read
 * (`app.unreadable`) shows none of its permissions either. Each App named
 * is checked once. One naming an independent workflow, store or trigger
 * only if they have a role in it or manage it (`resourcesOpen`).
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
  const named = listed.flatMap(({ subject: of, object }) => [
    ...(of.type === "app" ? [of.appId] : []),
    ...(object.type === "app" ? [object.appId] : []),
  ]);
  const readable = await appsReadableBy(env, by, [...new Set(named)]);
  const open: Permission[] = [];
  for (const permission of listed) {
    const { subject: of, object } = permission;
    const appsOpen =
      (of.type !== "app" || readable.has(of.appId)) &&
      (object.type !== "app" || readable.has(object.appId));
    // oxlint-disable-next-line no-await-in-loop -- each listed permission's own resources
    if (appsOpen && (await resourcesOpen(env, by, permission))) {
      open.push(permission);
    }
  }
  return open;
};
