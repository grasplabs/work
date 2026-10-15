import type { Acting } from "./auth/identity.ts";
import { requireStoreManager } from "./data-stores.ts";
import { requireTriggerManager } from "./trigger-resources.ts";
import { requireWorkflowRole } from "./workflow-resources.ts";

// Who may name an independent resource in a permission (permissions.ts,
// `requestPermission`): handed to it by its callers, as an App's roles
// are, so the permission records depend on no resource's registry.

/** An independent resource a permission names, as its subject or object. */
export interface ResourceRef {
  type: "workflow" | "store" | "trigger";
  id: string;
}

/**
 * Refuses `by` unless they may name `ref` in a permission: for a subject,
 * they build it (`builder`: a workflow's builders, a store's managers, a
 * trigger's manager); for a workflow object, they have a role in it
 * (`user`). Each refuses as for a resource that doesn't exist.
 */
export const requireResourceRole = async (
  env: Env,
  by: Acting,
  ref: ResourceRef,
  needed: "user" | "builder"
): Promise<void> => {
  switch (ref.type) {
    case "workflow": {
      await requireWorkflowRole(env, by, ref.id, needed);
      return;
    }
    case "store": {
      await requireStoreManager(env, by, ref.id);
      return;
    }
    case "trigger": {
      await requireTriggerManager(env, by, ref.id);
      return;
    }
    default: {
      ref.type satisfies never;
    }
  }
};
