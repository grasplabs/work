import type { BusinessProcess } from "@grasp-os/shared/business-processes";
import { failedRunDays } from "@grasp-os/shared/workflows";
import type { WorkflowSummary } from "@grasp-os/shared/workflows";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactElement, ReactNode } from "react";

import { formatDateTime, formatNumber } from "../format.ts";
import { RouterLink } from "../frame/router-link.tsx";
import { Avatar, AvatarFallback } from "../grasp/avatar/index.ts";
import { DataTable } from "../grasp/data-table/index.ts";
import type { DataTableColumn } from "../grasp/data-table/index.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { Icon, Workflow } from "../grasp/icons/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { ProcessTile } from "./business-process.tsx";
import { listsOf } from "./lists.ts";
import { RunResult } from "./runs.tsx";

// The workflows table, one row a workflow, on the library's Data table as
// the tables pattern has it, in a Section card: on the Workflows page,
// every workflow the person has a role in, in two lists. The workflow
// names the row (with the process it serves, or a workflow's mark, and its
// version); then whose it is and when it last ran; how often it ran and
// where it stands at the row's end. On a phone the table scrolls sideways
// inside its card, as every table does.

const styles = stylex.create({
  // The mark and the name with its version under it.
  lead: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    minWidth: 0,
  },
  named: { display: "grid", minWidth: 0 },
  mark: { display: "inline-flex", flexShrink: 0, color: grasp.muted },
  // The result over the runs that wait or failed, at the row's end.
  status: { display: "grid", justifyItems: "end", gap: grasp.space1 },
  stack: { display: "grid", gap: grasp.space6 },
});

/** When a workflow last ran, or that it never did. */
const LastRun = ({ workflow }: { workflow: WorkflowSummary }) => {
  const { t } = useLingui();
  return workflow.lastRun === null ? (
    <Text tone="muted">{t`Never`}</Text>
  ) : (
    formatDateTime(workflow.lastRun.createdAt)
  );
};

/** A count of a workflow's runs, linking to them on its page's Runs view. */
const RunCount = ({
  workflow,
  children,
  label,
}: {
  workflow: WorkflowSummary;
  children: ReactNode;
  /** What the link opens, read out: the count and the workflow, in words. */
  label: string;
}) => (
  <RouterLink
    aria-label={label}
    params={{ workflow: workflow.workflowId }}
    search={{ view: "runs" }}
    to="/workflows/$workflow"
  >
    {children}
  </RouterLink>
);

/**
 * Where a workflow stands: its last run's result, and the runs waiting
 * for a decision or failed lately, each a link to them on the Runs view.
 */
const Status = ({ workflow }: { workflow: WorkflowSummary }) => {
  const { t } = useLingui();
  const { name, waiting, failed } = workflow;
  const days = failedRunDays;
  return (
    <div {...stylex.props(styles.status)}>
      {workflow.lastRun === null ? (
        <Text tone="muted">–</Text>
      ) : (
        <RunResult
          aiProvider={workflow.lastRun.aiProvider}
          status={workflow.lastRun.status}
        />
      )}
      {waiting === 0 ? null : (
        <RunCount
          label={t`${plural(waiting, { one: "# waiting run", other: "# waiting runs" })} of ${name}`}
          workflow={workflow}
        >
          {t`${plural(waiting, { one: "# waiting", other: "# waiting" })}`}
        </RunCount>
      )}
      {failed === 0 ? null : (
        <RunCount
          label={t`${plural(failed, { one: "# failed run", other: "# failed runs" })} of ${name}`}
          workflow={workflow}
        >
          {t`${plural(failed, {
            one: `# failed in the last ${days} days`,
            other: `# failed in the last ${days} days`,
          })}`}
        </RunCount>
      )}
    </div>
  );
};

/** The business process each workflow serves, by its ID: null for none. */
export type WorkflowProcesses = ReadonlyMap<string, BusinessProcess | null>;

/** The process `row` serves. */
export const processOf = (
  processes: WorkflowProcesses | undefined,
  row: WorkflowSummary
): BusinessProcess | null => processes?.get(row.workflowId) ?? null;

/** The version new runs run, or that none is published yet. */
const Version = ({ version }: { version: number | null }) => {
  const { t } = useLingui();
  return version === null ? t`Draft` : t`Version ${version}`;
};

/** A workflow's owner: who created it, as their face, named to a screen reader and when pointed at. */
const Owner = ({ workflow }: { workflow: WorkflowSummary }) => {
  const name = workflow.owner.name ?? workflow.owner.userId;
  return (
    <Avatar name={name} size="xs">
      <AvatarFallback />
    </Avatar>
  );
};

/** What a workflow serves, its name and its version under it: what names its row. */
const WorkflowName = ({
  workflow,
  process,
}: {
  workflow: WorkflowSummary;
  process: BusinessProcess | null;
}) => (
  <span {...stylex.props(styles.lead)}>
    {process === null ? (
      <span aria-hidden="true" {...stylex.props(styles.mark)}>
        <Icon icon={Workflow} />
      </span>
    ) : (
      <ProcessTile process={process} />
    )}
    <span {...stylex.props(styles.named)}>
      <RouterLink
        params={{ workflow: workflow.workflowId }}
        to="/workflows/$workflow"
      >
        {workflow.name}
      </RouterLink>
      <Text size="sm" tone="muted">
        <Version version={workflow.version} />
      </Text>
    </span>
  </span>
);

/** What the Workflows page says while nobody can open any workflow. */
const NoWorkflows = () => {
  const { t } = useLingui();
  return (
    <Empty size="lg">
      <EmptyHeader>
        <EmptyMedia icon={Workflow} />
        <EmptyTitle>{t`No workflows yet`}</EmptyTitle>
        <EmptyDescription>
          {t`Workflows are made in chat: describe what should run on its own, and Grasp builds it.`}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <RouterLink search={{}} to="/">
          {t`Open Chat`}
        </RouterLink>
      </EmptyContent>
    </Empty>
  );
};

/** The workflows table's columns, under their headers' words. */
const workflowColumns = (words: {
  processes: WorkflowProcesses | undefined;
  workflow: string;
  owner: string;
  last: string;
  week: string;
  status: string;
}): DataTableColumn<WorkflowSummary>[] => [
  {
    key: "workflow",
    header: words.workflow,
    value: (row) => row.name,
    cell: (row) => (
      <WorkflowName process={processOf(words.processes, row)} workflow={row} />
    ),
  },
  {
    key: "owner",
    header: words.owner,
    value: (row) => row.owner.name ?? row.owner.userId,
    cell: (row) => <Owner workflow={row} />,
  },
  {
    key: "last",
    header: words.last,
    value: (row) => row.lastRun?.createdAt ?? "",
    cell: (row) => <LastRun workflow={row} />,
  },
  {
    key: "week",
    header: words.week,
    value: (row) => row.handled,
    cell: (row) => formatNumber(row.handled),
    align: "end",
  },
  {
    key: "status",
    header: words.status,
    value: (row) => row.lastRun?.status ?? "",
    cell: (row) => <Status workflow={row} />,
    align: "end",
  },
];

/**
 * Every workflow the person can open, in the library's Data table: one row
 * a workflow, its columns as above.
 */
export const WorkflowsTable = ({
  rows,
  empty,
  processes,
  label,
}: {
  rows: WorkflowSummary[];
  /** The process each row serves; none known without it. */
  processes?: WorkflowProcesses;
  /** What an empty table says; the Workflows page's empty state without it. */
  empty?: ReactElement;
  /** What the rows are, for a screen reader: the list's name. */
  label?: string;
}) => {
  const { t } = useLingui();
  if (rows.length === 0) {
    return empty ?? <NoWorkflows />;
  }
  const columns = workflowColumns({
    processes,
    workflow: t`Workflow`,
    owner: t({ message: "Owner", context: "column: who owns a workflow" }),
    last: t`Last run`,
    week: t`Runs a week`,
    status: t({
      message: "Status",
      context: "column: where a workflow stands",
    }),
  });
  return (
    <DataTable
      columns={columns}
      density="compact"
      label={label ?? t`Workflows`}
      rowKey={(row) => row.workflowId}
      rows={rows}
      unit={{ one: t`workflow`, other: t`workflows` }}
    />
  );
};

/** One of the overview's lists: a card with its name over its table, left out while empty. */
const List = ({
  title,
  rows,
  processes,
}: {
  title: string;
  rows: WorkflowSummary[];
  processes: WorkflowProcesses | undefined;
}) =>
  rows.length === 0 ? null : (
    <SectionCard density="compact" flush title={title}>
      <WorkflowsTable label={title} processes={processes} rows={rows} />
    </SectionCard>
  );

/**
 * `rows` in the overview's two lists, without the figure over them: at
 * work, those that have run, the ones waiting on a person first; on the
 * way, those that haven't run yet. Needs you shows its workflows so.
 */
export const WorkflowLists = ({
  rows,
  processes,
}: {
  rows: WorkflowSummary[];
  processes?: WorkflowProcesses;
}) => {
  const { t } = useLingui();
  const { atWork, onTheWay } = listsOf(rows);
  return (
    <>
      <List processes={processes} rows={atWork} title={t`At work`} />
      <List processes={processes} rows={onTheWay} title={t`On the way`} />
    </>
  );
};

/** The Workflows page's list: two lists, or the empty state while there is none. */
export const WorkflowsOverview = ({
  rows,
  processes,
}: {
  rows: WorkflowSummary[];
  processes?: WorkflowProcesses;
}) =>
  rows.length === 0 ? (
    <NoWorkflows />
  ) : (
    <div {...stylex.props(styles.stack)}>
      <WorkflowLists processes={processes} rows={rows} />
    </div>
  );
