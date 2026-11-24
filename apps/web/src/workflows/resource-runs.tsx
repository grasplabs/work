import { workflowRunsListed } from "@grasp-os/shared/workflow-resources";
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
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { formatDateTime } from "../format.ts";
import { useCore } from "../use-core.ts";
import type { Names } from "./activity-words.ts";
import { listRuns } from "./reads.ts";
import { RunStatusBadge, useStartedBy } from "./run-detail.tsx";
import { WaitingForAiProvider } from "./runs.tsx";

// An independent workflow's runs (GRA-674), newest first, the latest page,
// as core lists them for the reader: every run for its builders, their own
// for its users (`workflowResources.runs`). A run its engine holds for a
// decision says so, with the way to answer it, as the Runs log does: core
// says which decision only there (`workflows.runs`). Each row opens the
// run's own page (run-page.tsx).

const styles = stylex.create({
  // Its status over what it waits for, at the row's end.
  status: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: space["1"],
  },
  table: { display: "grid", rowGap: space["2"] },
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
    <Empty>
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
          <TextLink asChild variant="plain">
            <Link params={{ decision }} to="/decisions/$decision">
              {t`Decide`}
            </Link>
          </TextLink>
        </span>
      )}
      {run.aiProvider === undefined ? null : (
        <Text as="span" color="muted" size="xs">
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
    id: "started",
    header: words.started,
    value: (run) => run.createdAt,
    cell: (run) => formatDateTime(run.createdAt),
  },
  {
    id: "version",
    header: words.version,
    value: (run) => run.version,
    cell: (run) => words.versionOf(run.version),
  },
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
 * row opens its page.
 */
export const WorkflowRunsTable = ({
  workflow,
  runs,
  names,
  own = false,
}: {
  workflow: string;
  runs: WorkflowResourceRun[];
  names: Names;
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
        aria-label={t`Runs`}
        columns={columns}
        density="compact"
        getRowId={(run) => run.id}
        onRowClick={(run) => {
          void navigate({
            to: "/workflows/$workflow/runs/$run",
            params: { workflow, run: run.id },
          });
        }}
        pageSize={runsPageSize}
        rows={runs}
        unit={{ one: t`run`, other: t`runs` }}
      />
      {/* Core lists the newest runs only: the count above them is of those. */}
      {runs.length >= newest ? (
        <Text color="muted" size="sm">
          {t`Only the newest ${newest} runs show here.`}
        </Text>
      ) : null}
    </div>
  );
};
