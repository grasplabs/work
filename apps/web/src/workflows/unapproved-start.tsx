import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { Button } from "@grasp-os/ui/components/button";
import { Trans } from "@lingui/react/macro";

// A start core refused because an admin hasn't approved what the version
// reaches (`workflow.binding_unapproved`): core's message says what to do,
// and the page leads to where it is approved, the workflow's Files and
// apps tab.

/** Whether `error` is core refusing a start for an unapproved binding. */
export const isUnapprovedStart = (error: unknown): boolean =>
  workflowResourceErrors.codeOf(error) === "workflow.binding_unapproved";

/** Where its bindings are approved: the workflow's Files and apps tab. */
export const ToApprovals = ({ onFiles }: { onFiles: () => void }) => (
  <Button onClick={onFiles} size="xs" variant="link">
    <Trans>Open Files and apps</Trans>
  </Button>
);
