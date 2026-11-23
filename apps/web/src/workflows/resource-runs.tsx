import { workflowRunsListed } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { formatDateTime } from "../format.ts";
import { DataTable } from "../grasp/data-table/index.ts";
import type { DataTableColumn } from "../grasp/data-table/index.ts";
import { Empty, EmptyDescription, EmptyHeader } from "../grasp/empty/index.ts";
import { Link as TextLink } from "../grasp/link/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCore } from "../use-core.ts";
import type { Names } from "./activity-bar.tsx";
import { listRuns } from "./reads.ts";
import {
  RunBeside,
  RunStatusBadge,
  useOpenedRun,
  useStartedBy,
} from "./run-detail.tsx";
import { WaitingForAiProvider } from "./runs.tsx";

// An independent workflow's runs (GRA-674), newest first, the latest page,
// as core lists them for the reader: every run for its builders, their own
// for its users (`workflowResources.runs`). A run its engine holds for a
// decision says so, with the way to answer it, as the Runs log does: core
// says which decision only there (`workflows.runs`). Each row opens beside the list
// (run-detail.tsx) with what it returned or why it failed, read on the
// run itself under its own rule for who sees it; its steps stay for the
// workflow's builders, who read its definitions (Traces).

const styles = stylex.create({
  // Its status over what it waits for, at the row's end.
  status: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: grasp.space1,
  },
  table: { display: "grid", rowGap: grasp.space2 },
  // Decide, under its status, over the row's press area so it stays its
  // own. Not the column's `control`: that holds one line, and this cell
  // holds two.
  above: { position: "relative", zIndex: 1 },
});

/**
 * No runs yet, where a list of them would stand; for a reader who sees
 * only their own (`own`), that none of theirs are.
 */
const NoRuns = ({ own }: { own: boolean }) => {
  const { t } = useLingui();
  return (
    <Empty size="md">
      <EmptyHeader>
        <EmptyDescription>
          {own
            ? t`You haven't run it yet. Only your own runs show here.`
            : t`No runs yet.`}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
};

/** How many runs a page of a workflow's runs holds. */
const runsPageSize = 20;

/** Waiting runs' open decisions the reader may answer, by the run's ID. */
type Decisions = ReadonlyMap<string, string>;

const noDecisions: Decisions = new Map();

/**
 * The decisions `runs` of `workflow` wait for that the reader may answer,
 * read while any of them hasn't ended, and again as that changes: the
 * Runs log's waiting runs, which name them. None where that read fails.
 */
const useDecisions = (
  workflow: string,
  runs: readonly WorkflowResourceRun[]
): Decisions => {
  const core = useCore();
  // Read again whenever which runs are going changes: one may have ended.
  const going = runs
    .filter(({ endedAt }) => endedAt === null)
    .map(({ id }) => id)
    .join(" ");
  const [decisions, setDecisions] = useState<Decisions>(noDecisions);
  useEffect(() => {
    let left = false;
    const read = async (): Promise<void> => {
      try {
        const page = await core.withSession(
          async (session) => await listRuns(session, { status: "waiting" })
        );
        if (!left) {
          setDecisions(
            new Map(
              page.runs.flatMap(({ id, workflowId, decision }) =>
                workflowId === workflow && decision !== undefined
                  ? [[id, decision] as const]
                  : []
              )
            )
          );
        }
      } catch {
        // The runs say they wait, without the way to the decision.
      }
    };
    if (going !== "") {
      void read();
    }
    return () => {
      left = true;
    };
  }, [core, going, workflow]);
  return going === "" ? noDecisions : decisions;
};

/**
 * Its status as a Badge: a held run with a decision the reader may answer
 * waits for that decision, with Decide beside it, standing over the row's
 * press area; and what it waits for while its AI provider fails.
 */
const RunStatus = ({
  run,
  decision,
}: {
  run: WorkflowResourceRun;
  decision: string | undefined;
}) => {
  const { t } = useLingui();
  return (
    <span {...stylex.props(styles.status)}>
      <RunStatusBadge
        status={decision === undefined ? run.status : "waiting"}
      />
      {decision === undefined ? null : (
        <span {...stylex.props(styles.above)}>
          <TextLink
            render={<Link params={{ decision }} to="/decisions/$decision" />}
            variant="standalone"
          >
            {t`Decide`}
          </TextLink>
        </span>
      )}
      {run.aiProvider === undefined ? null : (
        <Text element="span" size="xs" tone="muted">
          <WaitingForAiProvider wait={run.aiProvider} />
        </Text>
      )}
    </span>
  );
};

/** A workflow's runs' columns, under their headers' words. */
const runColumns = (words: {
  decisions: Decisions;
  startedBy: (principal: WorkflowResourceRun["principal"]) => string;
  started: string;
  version: string;
  /** A version as people call it everywhere: "v3". */
  versionOf: (version: number) => string;
  by: string;
  ended: string;
  status: string;
}): DataTableColumn<WorkflowResourceRun>[] => [
  {
    key: "started",
    header: words.started,
    value: (run) => run.createdAt,
    cell: (run) => formatDateTime(run.createdAt),
  },
  {
    key: "version",
    header: words.version,
    value: (run) => run.version,
    cell: (run) => words.versionOf(run.version),
  },
  {
    key: "by",
    header: words.by,
    value: (run) => words.startedBy(run.principal),
  },
  {
    key: "ended",
    header: words.ended,
    value: (run) => run.endedAt ?? "",
    cell: (run) => (run.endedAt === null ? "" : formatDateTime(run.endedAt)),
  },
  {
    key: "status",
    header: words.status,
    value: (run) => run.status,
    cell: (run) => (
      <RunStatus
        decision={
          run.endedAt === null ? words.decisions.get(run.id) : undefined
        }
        run={run}
      />
    ),
    align: "end",
  },
];

/**
 * A workflow's runs, newest first, on the library's Data table as the
 * tables pattern has it: when it started names the row; its version, who
 * started it and when it ended; its status at the row's end. The whole
 * row opens it beside the list: a run open there has an address of its
 * own (`?run=`), kept with the project it came from.
 */
export const WorkflowRunsTable = ({
  workflow,
  runs,
  names,
  open,
  own = false,
}: {
  workflow: string;
  runs: WorkflowResourceRun[];
  names: Names;
  /** The run open beside the list, by its ID. */
  open: string | undefined;
  /** Whether core lists the reader's own runs alone: they use it, not build it. */
  own?: boolean;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const startedBy = useStartedBy(names);
  const decisions = useDecisions(workflow, runs);
  if (runs.length === 0) {
    return <NoRuns own={own} />;
  }
  const columns = runColumns({
    decisions,
    startedBy,
    started: t`Started`,
    version: t`Version`,
    versionOf: (version) => t`v${version}`,
    by: t`Started by`,
    ended: t`Ended`,
    status: t`Status`,
  });
  const newest = workflowRunsListed;
  return (
    <div {...stylex.props(styles.table)}>
      <DataTable
        columns={columns}
        density="compact"
        label={t`Runs`}
        onRowOpen={(run) => {
          void navigate({
            to: "/workflows/$workflow",
            params: { workflow },
            replace: true,
            search: (held) => ({
              project: held.project,
              view: "runs",
              run: run.id,
            }),
          });
        }}
        pageSize={runsPageSize}
        rowCurrent={(run) => run.id === open}
        rowKey={(run) => run.id}
        rows={runs}
        unit={{ one: t`run`, other: t`runs` }}
      />
      {/* Core lists the newest runs only: the count above them is of those. */}
      {runs.length >= newest ? (
        <Text size="sm" tone="muted">
          {t`Only the newest ${newest} runs show here.`}
        </Text>
      ) : null}
    </div>
  );
};

export const ResourceRuns = ({
  workflow,
  name,
  runs,
  names,
  admin,
  openRun,
  onCloseRun,
}: {
  workflow: string;
  /** The workflow's name, as people see it. */
  name: string;
  /** The run the address asks to open, by its ID. */
  openRun?: string | undefined;
  /** Clears the run from the address once it is closed. */
  onCloseRun?: () => void;
  runs: WorkflowResourceRun[];
  names: Names;
  /** Whether the reader is one of the organization's admins. */
  admin: boolean;
}) => {
  // The run the address names: one of the table's, Run's "Open the run",
  // or an older one a link names.
  const opened = useOpenedRun(workflow, runs, openRun);
  return (
    <RunBeside
      admin={admin}
      names={names}
      onClose={() => {
        onCloseRun?.();
      }}
      name={name}
      opened={opened}
      workflow={workflow}
    >
      <WorkflowRunsTable
        names={names}
        open={openRun}
        own
        runs={runs}
        workflow={workflow}
      />
    </RunBeside>
  );
};
