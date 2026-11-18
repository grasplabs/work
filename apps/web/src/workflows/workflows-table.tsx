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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { Icon, Workflow } from "../grasp/icons/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { StatsGrid } from "../grasp/stats/index.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../grasp/table/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { ProcessTile } from "./business-process.tsx";
import { handledOf, listsOf } from "./lists.ts";
import { RunResult } from "./runs.tsx";

// The workflows table, one row a workflow, on the library's Table in a
// Section card: on the Workflows page, every workflow the person has a role
// in, in two lists. A row begins with the process it serves (or a
// workflow's mark), then its name and version; how often it ran, when it
// last ran, whose it is and where it stands. A table wider than its card
// scrolls sideways inside it, so no column is lost on a narrow page.

/** The width of the list under which a row shows its status under its name. */
const narrowList = "@container workflows (width < 40rem)";

const styles = stylex.create({
  // The list measures its own width, whatever the page beside it.
  list: { containerName: "workflows", containerType: "inline-size" },
  // Wide: the table; narrow: the rows. One of them shows.
  wide: { display: { default: "block", [narrowList]: "none" } },
  narrow: { display: { default: "none", [narrowList]: "block" } },
  // The mark and the name with its version under it.
  lead: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    minWidth: 0,
  },
  named: { display: "grid", minWidth: 0 },
  mark: { display: "inline-flex", flexShrink: 0, color: grasp.muted },
  // The result over the runs that wait or failed.
  status: { display: "grid", justifyItems: "start", gap: grasp.space1 },
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

/**
 * A workflow's row: what it serves, its name and its version under it,
 * how often it ran, when it last ran, its owner and where it stands.
 */
const WorkflowRow = ({
  workflow,
  process,
}: {
  workflow: WorkflowSummary;
  process: BusinessProcess | null;
}) => (
  <TableRow>
    <TableCell lead>
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
    </TableCell>
    <TableCell align="end">{formatNumber(workflow.handled)}</TableCell>
    <TableCell>
      <LastRun workflow={workflow} />
    </TableCell>
    <TableCell>
      <Owner workflow={workflow} />
    </TableCell>
    <TableCell>
      <Status workflow={workflow} />
    </TableCell>
  </TableRow>
);

/**
 * A workflow on a narrow page, as the library's Item: what it serves, its
 * name and version, and where it stands under them, so its status is never
 * pushed out of sight. How often and when it ran stay on the wide table.
 */
const WorkflowItem = ({
  workflow,
  process,
}: {
  workflow: WorkflowSummary;
  process: BusinessProcess | null;
}) => (
  <Item size="sm">
    {process === null ? (
      <ItemMedia icon={Workflow} iconLook="inline" />
    ) : (
      <ItemMedia>
        <ProcessTile process={process} />
      </ItemMedia>
    )}
    <ItemContent>
      <ItemTitle>
        <RouterLink
          params={{ workflow: workflow.workflowId }}
          to="/workflows/$workflow"
        >
          {workflow.name}
        </RouterLink>
      </ItemTitle>
      <ItemDescription>
        <Version version={workflow.version} />
      </ItemDescription>
      <Status workflow={workflow} />
    </ItemContent>
  </Item>
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

/**
 * Every workflow the person can open, in the library's Table: one row a
 * workflow, its columns as above.
 */
export const WorkflowsTable = ({
  rows,
  empty,
  processes,
}: {
  rows: WorkflowSummary[];
  /** The process each row serves; none known without it. */
  processes?: WorkflowProcesses;
  /** What an empty table says; the Workflows page's empty state without it. */
  empty?: ReactElement;
}) => {
  const { t } = useLingui();
  if (rows.length === 0) {
    return empty ?? <NoWorkflows />;
  }
  return (
    <div {...stylex.props(styles.list)}>
      <div {...stylex.props(styles.wide)}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t`Workflow`}</TableHead>
              <TableHead align="end">{t`Runs a week`}</TableHead>
              <TableHead>{t`Last run`}</TableHead>
              <TableHead>
                {t({
                  message: "Owner",
                  context: "column: who owns a workflow",
                })}
              </TableHead>
              <TableHead>
                {t({
                  message: "Status",
                  context: "column: where a workflow stands",
                })}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <WorkflowRow
                key={row.workflowId}
                process={processOf(processes, row)}
                workflow={row}
              />
            ))}
          </TableBody>
        </Table>
      </div>
      <div {...stylex.props(styles.narrow)}>
        <ItemGroup aria-label={t`Workflows`} separated>
          {rows.map((row) => (
            <WorkflowItem
              key={row.workflowId}
              process={processOf(processes, row)}
              workflow={row}
            />
          ))}
        </ItemGroup>
      </div>
    </div>
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
      <WorkflowsTable processes={processes} rows={rows} />
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

/**
 * The Workflows page's list: the runs these workflows completed this week
 * (core's `handled`) as a figure, then two lists. The prototype's return a
 * month and what designs expect on top are left out: core measures no
 * return yet and keeps no designs, so they were always a dash.
 */
export const WorkflowsOverview = ({
  rows,
  processes,
}: {
  rows: WorkflowSummary[];
  processes?: WorkflowProcesses;
}) => {
  const { t } = useLingui();
  if (rows.length === 0) {
    return <NoWorkflows />;
  }
  return (
    <div {...stylex.props(styles.stack)}>
      <StatsGrid
        aria-label={t`These workflows, in figures`}
        columns={3}
        items={[
          {
            title: t`runs a week by these workflows`,
            value: formatNumber(handledOf(rows)),
          },
        ]}
      />
      <WorkflowLists processes={processes} rows={rows} />
    </div>
  );
};
