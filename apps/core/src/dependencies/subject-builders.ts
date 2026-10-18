import type {
  DependencySubject,
  NamedDependencySubject,
} from "@grasp-os/shared/dependencies";
import { roleErrors } from "@grasp-os/shared/roles";

import { appFor } from "../apps.ts";
import type { Acting } from "../auth/identity.ts";
import { requireWorkflowRole } from "../workflow-resources.ts";

// Who may ask for a subject's packages, or read them as one of its
// builders: an App's builders (`appFor`), or a workflow's
// (`requireWorkflowRole`). Apart from subjects.ts, which the workflow
// registry uses when it deletes a workflow.

/**
 * `subject`, for one of its builders, with its name: `app.not_found` or
 * `workflow.resource_unavailable` for anyone with no role in it, and
 * `role.forbidden` for one who only uses it.
 */
export const builtSubject = async (
  env: Env,
  by: Acting,
  subject: DependencySubject
): Promise<NamedDependencySubject> => {
  if (subject.type === "app") {
    const { id, name } = await appFor(env, by, subject.id, "builder");
    return { type: "app", id, name };
  }
  // Grasp staff neither ask for, build nor read a workflow's packages,
  // whatever role their session carries.
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const { id, name } = await requireWorkflowRole(
    env,
    by,
    subject.id,
    "builder"
  );
  return { type: "workflow", id, name };
};
