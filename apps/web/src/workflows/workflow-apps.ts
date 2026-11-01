import type {
  WorkflowBindingApproval,
  WorkflowVersionBinding,
} from "@grasp-os/shared/workflow-resources";
import type { ConnectionWorkflows } from "@grasp-os/shared/workflows";

import type { Integration } from "../connections/integrations.ts";

// The apps an independent workflow works in, from its connector bindings:
// those an active approval serves through a connection (core's
// `workflows.byConnection`, as Integrations reads it), each with how it
// stands, and those its current version declares that no approval serves
// yet, by alias and the catalog contract it names.

/** A connector binding of the current version no approval serves yet. */
export interface UnconnectedApp {
  alias: string;
  /** The catalog contract key it names, when the reader may see it. */
  contractId: string | null;
}

export interface WorkflowApps {
  /** The apps whose connections serve it, as Integrations lists them. */
  connected: Integration[];
  /** What its current version needs that no connection serves yet. */
  unconnected: UnconnectedApp[];
}

/**
 * The apps workflow `workflow` works in: the integrations whose
 * connections serve it, and the connector bindings of `currentVersion`
 * that no active approval for that version serves.
 */
export const workflowAppsOf = ({
  workflow,
  integrations,
  uses,
  currentVersion,
  bindings,
  approvals,
}: {
  workflow: string;
  integrations: readonly Integration[];
  uses: readonly ConnectionWorkflows[];
  currentVersion: number | null;
  bindings: readonly WorkflowVersionBinding[];
  approvals: readonly WorkflowBindingApproval[];
}): WorkflowApps => {
  // Each with only its connections that serve it: how it stands is theirs,
  // never another account's of the same app this workflow doesn't use.
  const serving = new Set(
    uses
      .filter(({ workflows }) =>
        workflows.some(
          (using) => using.kind === "independent" && using.id === workflow
        )
      )
      .map(({ connectionId }) => connectionId)
  );
  const connected = integrations.flatMap((integration) => {
    const own = integration.connections.filter(({ id }) => serving.has(id));
    return own.length === 0 ? [] : [{ ...integration, connections: own }];
  });
  const served = new Set(
    approvals
      .filter(
        ({ kind, status, reviewedVersion }) =>
          kind === "connector" &&
          status === "active" &&
          reviewedVersion === currentVersion
      )
      .map(({ alias }) => alias)
  );
  const unconnected = bindings
    .filter(({ kind, alias }) => kind === "connector" && !served.has(alias))
    .map(({ alias, contractId }) => ({ alias, contractId }))
    .toSorted((one, other) => one.alias.localeCompare(other.alias));
  return { connected, unconnected };
};
