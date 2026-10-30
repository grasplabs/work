import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { Button } from "@grasp-os/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";

import { formatDateTime } from "../format.ts";
import type { Names } from "./activity-bar.tsx";
import { RunSheet } from "./run-detail.tsx";
import { runDotOf, runStatusLabels } from "./run-status.ts";

// An independent workflow's runs (GRA-674), newest first, the latest page,
// as core lists them for the reader: every run for its builders, their own
// for its users (`workflowResources.runs`). Each opens beside the page
// (run-detail.tsx) with what it returned or why it failed, read on the
// run itself under its own rule for who sees it; its steps stay for the
// workflow's builders, who read its definitions (Traces).

/** The button on a run's row that opens it beside the page. */
export const OpenRun = ({
  started,
  onOpen,
}: {
  started: string;
  onOpen: () => void;
}) => {
  const { t } = useLingui();
  return (
    <Button
      aria-label={t`Open the run started ${started}`}
      onClick={onOpen}
      size="sm"
      variant="ghost"
    >
      {t({ message: "Open", context: "open one run of a workflow" })}
    </Button>
  );
};

export const ResourceRuns = ({
  workflow,
  runs,
  names,
  admin,
}: {
  workflow: string;
  runs: WorkflowResourceRun[];
  names: Names;
  /** Whether the reader is one of the organization's admins. */
  admin: boolean;
}) => {
  const { t } = useLingui();
  const captionId = useId();
  const [opened, setOpened] = useState<WorkflowResourceRun | null>(null);
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
              <TableHead variant="card">
                <span className="sr-only">
                  {t({
                    message: "Open",
                    context: "column: a button that opens a run",
                  })}
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => {
              const started = formatDateTime(run.createdAt);
              return (
                <TableRow key={run.id}>
                  <TableCell variant="roomy">{started}</TableCell>
                  <TableCell variant="roomy">
                    <span className="inline-flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={`${runDotOf(run.status)} size-1.75 flex-none rounded-full`}
                      />
                      {t(runStatusLabels[run.status])}
                    </span>
                  </TableCell>
                  <TableCell variant="roomy">{run.version}</TableCell>
                  <TableCell variant="roomy">
                    {run.principal === names.me
                      ? t`You`
                      : (names.people.get(run.principal) ?? t`Someone else`)}
                  </TableCell>
                  <TableCell variant="roomy">
                    {run.endedAt === null ? "" : formatDateTime(run.endedAt)}
                  </TableCell>
                  <TableCell variant="roomy">
                    <OpenRun
                      onOpen={() => {
                        setOpened(run);
                      }}
                      started={started}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-muted-foreground" id={captionId}>
        <Trans>The latest runs, newest first.</Trans>
      </p>
      <RunSheet
        admin={admin}
        names={names}
        onClose={() => {
          setOpened(null);
        }}
        opened={opened}
        workflow={workflow}
      />
    </div>
  );
};
