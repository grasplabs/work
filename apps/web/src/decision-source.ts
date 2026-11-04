import type { DecisionView } from "@grasp-os/shared/decisions";

import type { Crumb } from "./frame/site-header.tsx";

/**
 * The crumb of the workflow whose run asks, linking its App's workflow or
 * an independent workflow's own page when core says the reader may open
 * it; otherwise only its name.
 */
export const decisionSource = (decision: DecisionView): Crumb => {
  const { app, workflowResource, workflow } = decision;
  if (decision.opens === true && app !== undefined) {
    return {
      label: workflow,
      to: "/workflows/$app/$workflow",
      params: { app: app.id, workflow },
    };
  }
  if (decision.opens === true && workflowResource !== undefined) {
    return {
      label: workflowResource.name,
      to: "/workflows/$workflow",
      params: { workflow: workflowResource.id },
    };
  }
  return { label: workflowResource?.name ?? workflow };
};
