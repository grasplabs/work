import type { DecisionView } from "@grasp-os/shared/decisions";

import type { Crumb } from "./frame/site-header.tsx";

/**
 * The crumb of the workflow whose run asks: its App's workflow, or an
 * independent workflow's own page when core says the reader may open it;
 * otherwise only its name.
 */
export const decisionSource = (decision: DecisionView): Crumb => {
  if (decision.app !== undefined) {
    return {
      label: decision.workflow,
      to: "/workflows/$app/$workflow",
      params: { app: decision.app.id, workflow: decision.workflow },
    };
  }
  if (decision.workflowResource?.opens === true) {
    return {
      label: decision.workflowResource.name,
      to: "/workflows/$workflow",
      params: { workflow: decision.workflowResource.id },
    };
  }
  return { label: decision.workflowResource?.name ?? decision.workflow };
};
