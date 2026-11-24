import type { DecisionView } from "@grasp-os/shared/decisions";

import type { Crumb } from "./frame/site-header.tsx";

/**
 * The crumb of the workflow whose run asks, linking its own page when core
 * says the reader may open it; otherwise only its name.
 */
export const decisionSource = (decision: DecisionView): Crumb => {
  const { workflowResource } = decision;
  if (decision.opens === true) {
    return {
      label: workflowResource.name,
      to: "/workflows/$workflow",
      params: { workflow: workflowResource.id },
    };
  }
  return { label: workflowResource.name };
};
