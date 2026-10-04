import { failedRunDays } from "@grasp-os/shared/workflows";
import type {
  RunFilterStatus,
  WorkflowSummary,
} from "@grasp-os/shared/workflows";
import { Badge } from "@grasp-os/ui/components/badge";
import { buttonVariants } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { plural } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, WorkflowIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { formatDateTime } from "../format.ts";
import { RunResult } from "./runs.tsx";

// The workflows table, as the prototype draws it
// (`components/workflows-table.tsx`): on the Workflows page, every
// workflow the person can open; on an engine's page, that engine's.

/** When a workflow last ran, or that it never did. */
const LastRun = ({ workflow }: { workflow: WorkflowSummary }) =>
  workflow.lastRun === null ? (
    <span className="text-muted-foreground">
      <Trans>Never</Trans>
    </span>
  ) : (
    <span className="tabular-nums">
      {formatDateTime(workflow.lastRun.createdAt)}
    </span>
  );

/** A count of a workflow's runs, linking to them on the Runs tab. */
const RunCount = ({
  workflow,
  status,
  children,
  label,
}: {
  workflow: WorkflowSummary;
  status: RunFilterStatus;
  children: ReactNode;
  /** What the link opens, read out: the count and the workflow, in words. */
  label: string;
}) => (
  <Link
    aria-label={label}
    className="relative z-10 underline-offset-4 hover:underline"
    search={{
      tab: "runs",
      app: workflow.app,
      workflow: workflow.workflow,
      status,
    }}
    to="/workflows"
  >
    {children}
  </Link>
);

/**
 * Where a workflow stands: its last run's result, and the runs waiting
 * for a decision or failed lately, each a link to them on the Runs tab.
 */
const Status = ({ workflow }: { workflow: WorkflowSummary }) => {
  const { t } = useLingui();
  const name = workflow.workflow;
  const { waiting, failed } = workflow;
  const days = failedRunDays;
  return (
    <div className="flex flex-col items-start gap-0.5">
      {workflow.lastRun === null ? (
        <span className="text-muted-foreground">–</span>
      ) : (
        <RunResult status={workflow.lastRun.status} />
      )}
      {waiting === 0 ? null : (
        <RunCount
          label={t`${plural(waiting, { one: "# waiting run", other: "# waiting runs" })} of ${name}`}
          status="waiting"
          workflow={workflow}
        >
          <Plural one="# waiting" other="# waiting" value={waiting} />
        </RunCount>
      )}
      {failed === 0 ? null : (
        <RunCount
          label={t`${plural(failed, { one: "# failed run", other: "# failed runs" })} of ${name}`}
          status="failed"
          workflow={workflow}
        >
          <Plural
            one={`# failed in the last ${days} days`}
            other={`# failed in the last ${days} days`}
            value={failed}
          />
        </RunCount>
      )}
    </div>
  );
};

/**
 * A workflow's row: its name, the App it is in and its version under it,
 * when it last ran and where it stands. The whole row opens it.
 */
const WorkflowRow = ({
  workflow,
  withEngine,
}: {
  workflow: WorkflowSummary;
  withEngine: boolean;
}) => {
  const { version, appName } = workflow;
  return (
    <TableRow className="relative">
      <TableCell variant="roomy">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <Link
              className="truncate outline-none after:absolute after:inset-0 focus-visible:underline"
              params={{ app: workflow.app, workflow: workflow.workflow }}
              to="/workflows/$app/$workflow"
            >
              {workflow.workflow}
            </Link>
            {workflow.scheduleStopped ? (
              <Badge variant="destructive">
                <Trans>Schedule stopped</Trans>
              </Badge>
            ) : null}
          </span>
          {/* Narrow, the engine's cell is hidden: its name and version here. */}
          {withEngine ? (
            <span className="text-muted-foreground truncate @lg:hidden">
              <Trans>
                {appName} · Version {version}
              </Trans>
            </span>
          ) : (
            <span className="text-muted-foreground">
              <Trans>Version {version}</Trans>
            </span>
          )}
        </div>
      </TableCell>
      {withEngine ? (
        <TableCell className="hidden @lg:table-cell" variant="roomy">
          <div className="flex min-w-0 flex-col gap-0.5">
            <Link
              className="relative z-10 truncate underline-offset-4 hover:underline"
              params={{ engine: workflow.app }}
              to="/engines/$engine"
            >
              {workflow.appName}
            </Link>
            <span className="text-muted-foreground">
              <Trans>Version {version}</Trans>
            </span>
          </div>
        </TableCell>
      ) : null}
      <TableCell className="hidden @2xl:table-cell" variant="roomy">
        <LastRun workflow={workflow} />
      </TableCell>
      <TableCell variant="roomy">
        <Status workflow={workflow} />
      </TableCell>
      <TableCell>
        <ChevronRightIcon
          aria-hidden="true"
          className="text-muted-foreground mx-auto size-4"
        />
      </TableCell>
    </TableRow>
  );
};

/**
 * Every workflow the person can open, in the prototype's table
 * (grasplabs/prototype `components/workflows-table.tsx`): its columns
 * follow the table's own width, so as it narrows, the last run and then
 * the App fold away.
 */
export const WorkflowsTable = ({
  rows,
  withEngine = true,
  empty,
}: {
  rows: WorkflowSummary[];
  /** The engine column: left out where the table is the engine's own. */
  withEngine?: boolean;
  /** What an empty table says; the Workflows page's empty state without it. */
  empty?: ReactElement;
}) => {
  if (rows.length === 0 && empty !== undefined) {
    return empty;
  }
  if (rows.length === 0) {
    return (
      <div className="bg-card rounded-xl border">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <WorkflowIcon />
            </EmptyMedia>
            <EmptyTitle>
              <Trans>No workflows yet</Trans>
            </EmptyTitle>
            <EmptyDescription>
              <Trans>
                Workflows are made in chat: describe what should run on its own,
                and Grasp builds it into an App.
              </Trans>
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Link
              className={buttonVariants({ size: "sm", variant: "outline" })}
              search={{}}
              to="/"
            >
              <Trans>Open Chat</Trans>
            </Link>
          </EmptyContent>
        </Empty>
      </div>
    );
  }
  return (
    <div className="bg-card @container overflow-hidden rounded-xl border">
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead variant="card">
              <Trans>Workflow</Trans>
            </TableHead>
            {withEngine ? (
              <TableHead className="hidden w-56 @lg:table-cell" variant="card">
                <Trans>Engine</Trans>
              </TableHead>
            ) : null}
            <TableHead className="hidden w-44 @2xl:table-cell" variant="card">
              <Trans>Last run</Trans>
            </TableHead>
            <TableHead className="w-52" variant="card">
              <Trans context="column: where a workflow stands">Status</Trans>
            </TableHead>
            <TableHead className="w-9" variant="card">
              <span className="sr-only">
                <Trans context="column: a link that opens the workflow">
                  Open
                </Trans>
              </span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <WorkflowRow
              key={`${row.app}/${row.workflow}`}
              withEngine={withEngine}
              workflow={row}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
};
