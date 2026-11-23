import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { DataTable } from "@grasp-os/ui/components/data-table";
import type { DataTableColumn } from "@grasp-os/ui/components/data-table";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import { Link as TextLink } from "@grasp-os/ui/components/link";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";

import { formatDateTime } from "../format.ts";
import type { Names } from "./activity-bar.tsx";
import { RunBeside, RunStatusBadge, useStartedBy } from "./run-detail.tsx";
import { WaitingForAiProvider } from "./runs.tsx";

// An independent workflow's runs (GRA-674), newest first, the latest page,
// as core lists them for the reader: every run for its builders, their own
// for its users (`workflowResources.runs`). Each opens beside the list
// (run-detail.tsx) with what it returned or why it failed, read on the
// run itself under its own rule for who sees it; its steps stay for the
// workflow's builders, who read its definitions (Traces).

const styles = stylex.create({
  // Its status over what it waits for, at the row's end.
  status: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: space["1"],
  },
});

/**
 * When a run started, as a link to it opened beside the list: a run open
 * there has an address of its own (`?run=`), kept with the project it came
 * from.
 */
const RunLink = ({
  workflow,
  run,
}: {
  workflow: string;
  run: WorkflowResourceRun;
}) => (
  <TextLink asChild variant="plain">
    <Link
      params={{ workflow }}
      replace
      search={(held) => ({
        project: held.project,
        view: "runs",
        run: run.id,
      })}
      to="/workflows/$workflow"
    >
      {formatDateTime(run.createdAt)}
    </Link>
  </TextLink>
);

/** No runs yet, where a list of them would stand. */
const NoRuns = () => {
  const { t } = useLingui();
  return (
    <Empty>
      <EmptyHeader>
        <EmptyDescription>{t`No runs yet.`}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
};

/** How many runs a page of a workflow's runs holds. */
const runsPageSize = 20;

/** Its status as a Badge, and what it waits for while its AI provider fails. */
const RunStatus = ({ run }: { run: WorkflowResourceRun }) => (
  <span {...stylex.props(styles.status)}>
    <RunStatusBadge status={run.status} />
    {run.aiProvider === undefined ? null : (
      <Text as="span" color="muted" size="xs">
        <WaitingForAiProvider wait={run.aiProvider} />
      </Text>
    )}
  </span>
);

/** A workflow's runs' columns, under their headers' words. */
const runColumns = (words: {
  workflow: string;
  startedBy: (principal: WorkflowResourceRun["principal"]) => string;
  started: string;
  version: string;
  by: string;
  ended: string;
  status: string;
}): DataTableColumn<WorkflowResourceRun>[] => [
  {
    id: "started",
    header: words.started,
    value: (run) => run.createdAt,
    cell: (run) => <RunLink run={run} workflow={words.workflow} />,
  },
  { id: "version", header: words.version, value: (run) => run.version },
  {
    id: "by",
    header: words.by,
    value: (run) => words.startedBy(run.principal),
  },
  {
    id: "ended",
    header: words.ended,
    value: (run) => run.endedAt ?? "",
    cell: (run) => (run.endedAt === null ? "" : formatDateTime(run.endedAt)),
  },
  {
    id: "status",
    header: words.status,
    value: (run) => run.status,
    cell: (run) => <RunStatus run={run} />,
    align: "end",
  },
];

/**
 * A workflow's runs, newest first, on Damsko's Data table as the
 * tables pattern has it: when it started names the row; its version, who
 * started it and when it ended; its status at the row's end. When it
 * started is the link that opens it beside the list.
 */
export const WorkflowRunsTable = ({
  workflow,
  runs,
  names,
}: {
  workflow: string;
  runs: WorkflowResourceRun[];
  names: Names;
}) => {
  const { t } = useLingui();
  const startedBy = useStartedBy(names);
  if (runs.length === 0) {
    return <NoRuns />;
  }
  const columns = runColumns({
    workflow,
    startedBy,
    started: t`Started`,
    version: t`Version`,
    by: t`Started by`,
    ended: t`Ended`,
    status: t`Status`,
  });
  return (
    <DataTable
      aria-label={t`Runs`}
      columns={columns}
      density="compact"
      getRowId={(run) => run.id}
      pageSize={runsPageSize}
      rows={runs}
      unit={{ one: t`run`, other: t`runs` }}
    />
  );
};

export const ResourceRuns = ({
  workflow,
  runs,
  names,
  admin,
  openRun,
  onCloseRun,
}: {
  workflow: string;
  /** The run the address asks to open, by its ID. */
  openRun?: string | undefined;
  /** Clears the run from the address once it is closed. */
  onCloseRun?: () => void;
  runs: WorkflowResourceRun[];
  names: Names;
  /** Whether the reader is one of the organization's admins. */
  admin: boolean;
}) => {
  // The run the address names: one of the table's, or Run's "Open the run".
  const opened = runs.find((run) => run.id === openRun) ?? null;
  return (
    <RunBeside
      admin={admin}
      names={names}
      onClose={() => {
        onCloseRun?.();
      }}
      opened={opened}
      workflow={workflow}
    >
      <WorkflowRunsTable names={names} runs={runs} workflow={workflow} />
    </RunBeside>
  );
};
