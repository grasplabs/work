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

/** Each resource's answer, by its kind and ID, for one listing. */
type Answers = Map<string, Promise<boolean>>;

/**
 * Whether `by` may see the independent resources `permission` names (its
 * workflow, store or trigger subject; its workflow object): an admin sees
 * every one; anyone else those they have a role in or manage, each as its
 * own registry decides it. Each resource is asked once per listing
 * (`answers`), however many of its permissions are listed, revoked ones
 * included.
 */
const resourcesOpen = async (
  env: Env,
  by: Member,
  { subject, object }: Permission,
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
  const open = await Promise.all(checks);
  return open.every(Boolean);
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
  const answers: Answers = new Map();
  for (const permission of listed) {
    const { subject: of, object } = permission;
    const appsOpen =
      (of.type !== "app" || readable.has(of.appId)) &&
      (object.type !== "app" || readable.has(object.appId));
    // oxlint-disable-next-line no-await-in-loop -- each listed permission's own resources
    if (appsOpen && (await resourcesOpen(env, by, permission, answers))) {
      open.push(permission);
    }
  }
  return open;
};
