import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { useLingui } from "@lingui/react/macro";

import { Button } from "../grasp/button/index.ts";
import { ArrowRight } from "../grasp/icons/index.ts";

// A start core refused because an admin hasn't approved what the version
// reaches (`workflow.binding_unapproved`): core's message says what to do,
// and the page leads to where it is approved, the workflow's Files and
// apps tab.

/** Whether `error` is core refusing a start for an unapproved binding. */
export const isUnapprovedStart = (error: unknown): boolean =>
  workflowResourceErrors.codeOf(error) === "workflow.binding_unapproved";

/** Where its bindings are approved: the workflow's Files and apps tab. */
export const ToApprovals = ({ onFiles }: { onFiles: () => void }) => {
  const { t } = useLingui();
  return (
    <Button iconEnd={ArrowRight} onClick={onFiles} size="xs" variant="ghost">
      {t`Open Files and apps`}
    </Button>
  );
};
