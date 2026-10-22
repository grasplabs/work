import type {
  WorkflowResourceRun,
  WorkflowRunStatus,
} from "@grasp-os/shared/workflow-resources";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId } from "react";

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

/** The colour of a run's dot, as the runs log has it (`runs.tsx`). */
const dotOf = (status: WorkflowRunStatus): string => {
  if (status === "completed") {
    return "bg-status-agreed";
  }
  return status === "failed" ? "bg-status-attention" : "bg-foreground";
};

export const ResourceRuns = ({
  runs,
  me,
}: {
  runs: WorkflowResourceRun[];
  me: string;
}) => {
  const { t } = useLingui();
  const captionId = useId();
  if (runs.length === 0) {
    return (
      <p className="bg-card text-muted-foreground rounded-xl border px-4 py-6 text-center">
        <Trans>No runs yet.</Trans>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="bg-card overflow-hidden rounded-xl border">
        <Table aria-describedby={captionId}>
          <TableHeader>
            <TableRow>
              <TableHead variant="card">{t`Started`}</TableHead>
              <TableHead variant="card">{t`Status`}</TableHead>
              <TableHead variant="card">{t`Version`}</TableHead>
              <TableHead variant="card">{t`Started by`}</TableHead>
              <TableHead variant="card">{t`Ended`}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell variant="roomy">
                  {formatDateTime(run.createdAt)}
                </TableCell>
                <TableCell variant="roomy">
                  <span className="inline-flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={`${dotOf(run.status)} size-1.75 flex-none rounded-full`}
                    />
                    {t(statusLabels[run.status])}
                  </span>
                </TableCell>
                <TableCell variant="roomy">{run.version}</TableCell>
                <TableCell variant="roomy">
                  {run.principal === me ? t`You` : t`Someone else`}
                </TableCell>
                <TableCell variant="roomy">
                  {run.endedAt === null ? "" : formatDateTime(run.endedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-muted-foreground" id={captionId}>
        <Trans>The latest runs, newest first.</Trans>
      </p>
    </div>
  );
};
