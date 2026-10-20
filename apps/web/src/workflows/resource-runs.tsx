import type {
  WorkflowResourceRun,
  WorkflowRunStatus,
} from "@grasp-os/shared/workflow-resources";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";

import { formatDateTime } from "../format.ts";

// An independent workflow's runs (GRA-674), newest first, the latest page,
// as core lists them for the reader: every run for its builders, their own
// for its users (`workflowResources.runs`). What a run returned or why it
// failed stays on the run itself, under its own rule for who sees it.

// Each in a context of its own: a run's status, not a workflow's.
const statusLabels: Readonly<Record<WorkflowRunStatus, MessageDescriptor>> = {
  starting: msg({ message: "Starting", context: "status of a workflow run" }),
  running: msg({ message: "Running", context: "status of a workflow run" }),
  completed: msg({ message: "Completed", context: "status of a workflow run" }),
  failed: msg({ message: "Failed", context: "status of a workflow run" }),
  cancelled: msg({ message: "Cancelled", context: "status of a workflow run" }),
};

export const ResourceRuns = ({
  runs,
  me,
}: {
  runs: WorkflowResourceRun[];
  me: string;
}) => {
  const { t } = useLingui();
  if (runs.length === 0) {
    return (
      <p className="text-muted-foreground">
        <Trans>No runs yet.</Trans>
      </p>
    );
  }
  return (
    <Table>
      <TableCaption>
        <Trans>The latest runs, newest first.</Trans>
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>{t`Started`}</TableHead>
          <TableHead>{t`Status`}</TableHead>
          <TableHead>{t`Version`}</TableHead>
          <TableHead>{t`Started by`}</TableHead>
          <TableHead>{t`Ended`}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id}>
            <TableCell>{formatDateTime(run.createdAt)}</TableCell>
            <TableCell>{t(statusLabels[run.status])}</TableCell>
            <TableCell>{run.version}</TableCell>
            <TableCell>
              {run.principal === me ? t`You` : t`Someone else`}
            </TableCell>
            <TableCell>
              {run.endedAt === null ? "" : formatDateTime(run.endedAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};
