import type { AuditDetailValue } from "@grasp-os/shared/audit";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Permission } from "@grasp-os/shared/permissions";

import { auditedCall, chatAuthority, requireOpenRun } from "./agent-scope.ts";
import type { AgentScope, CallOutcome } from "./agent-scope.ts";
import { memberOf } from "./auth/identity.ts";
import type { Member } from "./auth/identity.ts";
import { forSandbox } from "./bindings.ts";
import { grantedPermissions } from "./permissions.ts";

// Calls of a chat's code that go through the functions of the person's own
// session (reading Apps and workflows, building Apps and workflows): as the
// chat's person, read now, so the agent sees and does no more than they
// could. A call that reaches a resource (an App's functions, a workflow's
// runs) also needs a permission the agent holds for it (`allowed`).
// Building, and reading the person's own Apps, need none: they are the
// person's own acts, under their name, bounded by their role.

/** One read of the chat's code, as `asPerson` runs it. */
export interface PersonRead<T> {
  /**
   * Whether the agent's permissions, read now, allow it. Without it the
   * call needs none, and `read` is handed none.
   */
  allowed?: (permissions: Permission[]) => boolean;
  /** What the permission it lacks would allow: `read` unless it writes. */
  action?: "read" | "write";
  /** The API and method, for the audit log. */
  method: string;
  read: (person: Member, permissions: Permission[]) => Promise<T>;
  /** Identifiers and counts for the audit log, never what was read. */
  detail?: (result: T) => Record<string, AuditDetailValue>;
  /** How an answer that is itself a refusal or failure ended, for the audit log. */
  ended?: (
    result: T
  ) => { outcome: CallOutcome; reason: string | null } | undefined;
}

/** The permission a read, or a write, refuses without. */
export const readDenied = (action: "read" | "write" = "read") =>
  permissionErrors.create("permission.denied", { action });

/**
 * Runs one read as the chat's person, once the run's check passed and,
 * for a call that names one (`allowed`), the agent holds a permission for
 * it, and audits it as `agent.call` however it ends: a refusal too, with
 * why. Errors as the sandbox sees them.
 */
export const asPerson = async <T>(
  env: Env,
  scope: AgentScope,
  { allowed, action, method, read, detail, ended }: PersonRead<T>
): Promise<T> => {
  await requireOpenRun(env, scope, method);
  try {
    return await auditedCall(
      env,
      scope,
      {
        method,
        ...(detail === undefined ? {} : { detailOf: detail }),
        ...(ended === undefined ? {} : { endedOf: ended }),
      },
      async () => {
        const permissions =
          allowed === undefined
            ? []
            : await grantedPermissions(env, chatAuthority(scope));
        if (allowed !== undefined && !allowed(permissions)) {
          throw readDenied(action);
        }
        const person = await memberOf(env.DB, scope.personId);
        if (person === undefined) {
          throw permissionErrors.create("permission.person_inactive");
        }
        return await read(person, permissions);
      }
    );
  } catch (error) {
    throw forSandbox(error);
  }
};
