import { expectedMessageOf, failureText } from "@grasp-os/shared/errors";
import type {
  TraceState,
  TraceStep,
  WorkflowRunTrace,
} from "@grasp-os/shared/workflow-diagrams";
import type {
  WorkflowActivity,
  WorkflowResourceRun,
} from "@grasp-os/shared/workflow-resources";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useEffectEvent, useState } from "react";

import { isTransient } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { AgentActivity } from "../grasp/agent-activity/index.ts";
import type {
  ActivityState,
  ActivityStep,
} from "../grasp/agent-activity/index.ts";
import { Empty, EmptyDescription, EmptyHeader } from "../grasp/empty/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../grasp/table/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Toggle, ToggleGroup } from "../grasp/toggle/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { ActivityLine, activityKey } from "./activity-bar.tsx";
import type { Names } from "./activity-bar.tsx";
import { ItemTest } from "./item-test.tsx";
import { ListedCount } from "./listed-count.tsx";
import { NoRuns, OpenRun } from "./resource-runs.tsx";
import { RunBeside, RunStatusBadge, useStartedBy } from "./run-detail.tsx";
import { WorkflowDiagramView } from "./workflow-diagram.tsx";

// A workflow's Traces, for its builders (prototype `inside-traces.tsx`):
// one thing at a time behind a switch. Runs: a test of the draft on recent
// real items, then every run, a row each; a row opens beside the list with
// when it ran, how it ended and what it returned or why it failed
// (run-detail.tsx), then what the run did laid over its own version's
// diagram, and each step its journal recorded with its state, attempts,
// loop item and error code (`workflowResources.runTrace`), as the
// library's Agent activity. Activity: everything that happened to the
// workflow, in full.

/** Which part of Traces shows. */
export type TracesPart = "runs" | "activity";

/** How often a run still going is read again. */
const followMs = 1500;

const styles = stylex.create({
  traces: { display: "grid", rowGap: grasp.space6, minWidth: 0 },
  // Kept, but not shown, while Activity shows.
  away: { display: "none" },
  // A run's steps, in the card of its "What it did".
  did: {
    display: "grid",
    rowGap: grasp.space4,
    paddingBlock: grasp.space3,
    paddingInline: grasp.inspectorInset,
    minWidth: 0,
  },
  lines: {
    margin: 0,
    paddingBlock: grasp.space2,
    paddingInline: grasp.space4,
    listStyle: "none",
  },
});

/**
 * Where a run is, as a read of its trace says it, for what follows it (the
 * run panel's facts, run-detail.tsx): its status, and, while a step waits
 * for its AI provider, that wait. A wait begun or ended moves it, as its
 * status, still running, doesn't.
 */
export const followedState = (trace: WorkflowRunTrace): string =>
  trace.aiProvider === undefined
    ? trace.status
    : `${trace.status}:${trace.aiProvider.trouble}:${trace.aiProvider.since}`;

/** Ended, or nothing more of it is shown: no need to read it again. */
const settled = (trace: WorkflowRunTrace): boolean =>
  trace.status === "completed" ||
  trace.status === "failed" ||
  trace.status === "cancelled" ||
  trace.detailsRemoved;

/** A step's state, as Agent activity says a step's. */
const activityStates: Readonly<Record<TraceState, ActivityState>> = {
  reached: "done",
  running: "working",
  waiting: "waiting",
  failed: "failed",
};

/**
 * Why a step failed, in core's words where core has them (the workflow
 * errors register with `@grasp-os/shared/workflow-resources`, which this
 * page loads), else its code.
 */
const failureOf = (code: string): string => expectedMessageOf(code) ?? code;

/**
 * The steps its journal recorded, as Agent activity's: the task, with its
 * loop item, its attempts and when it started in the quiet note after it,
 * and why it failed as its result.
 */
const useActivitySteps = () => {
  const { t } = useLingui();
  return (steps: readonly TraceStep[]): ActivityStep[] =>
    steps.map((step) => {
      const { item, attempts, errorCode } = step;
      const notes = [
        ...(item === null ? [] : [t`Item ${item}`]),
        ...(attempts > 1
          ? [
              t`${plural(attempts, {
                one: "# attempt",
                other: "# attempts",
              })}`,
            ]
          : []),
        formatDateTime(step.startedAt),
      ];
      return {
        id: String(step.ordinal),
        kind: "tool",
        title: step.task,
        state: activityStates[step.state],
        summary: notes.join(" · "),
        ...(errorCode === null ? {} : { result: failureOf(errorCode) }),
      };
    });
};

/** What run `runId` did, read again until it ends. */
const RunTraceDetail = ({
  workflow,
  runId,
  onStatus,
}: {
  workflow: string;
  runId: string;
  /** Where the run is, as each read of its trace says it (`followedState`). */
  onStatus: (status: string) => void;
}) => {
  const core = useCore();
  const { t } = useLingui();
  const activitySteps = useActivitySteps();
  const [trace, setTrace] = useState<WorkflowRunTrace>();
  const [failure, setFailure] = useState<string>();
  const told = useEffectEvent(onStatus);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const follow = async (): Promise<void> => {
      try {
        const read = await core.withSession(
          async (session) =>
            await session.workflowResources.runTrace(workflow, runId)
        );
        if (stopped) {
          return;
        }
        setTrace(read);
        setFailure(undefined);
        told(followedState(read));
        if (!settled(read)) {
          timer = setTimeout(() => {
            void follow();
          }, followMs);
        }
      } catch (error) {
        if (!stopped) {
          setFailure(failureText(error));
          if (isTransient(error)) {
            timer = setTimeout(() => {
              void follow();
            }, followMs);
          }
        }
      }
    };
    void follow();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [core, runId, workflow]);

  if (trace === undefined) {
    return failure === undefined ? null : (
      <div {...stylex.props(styles.did)}>
        <ErrorText>{failure}</ErrorText>
      </div>
    );
  }
  const { version } = trace;
  const states = new Map(trace.tasks.map(({ task, state }) => [task, state]));
  const attempts = new Map(
    trace.tasks.map(({ task, attempts: made }) => [task, made])
  );
  const stepByStep = t({
    message: "Step by step",
    context: "the steps of one run, one under the other",
  });
  // How it stands is said over it, with its result (run-detail.tsx).
  return (
    <div {...stylex.props(styles.did)}>
      <ErrorText>{failure}</ErrorText>
      {trace.detailsRemoved ? (
        <Text size="sm" tone="muted">
          {t`The details of this run were removed when its retention ended.`}
        </Text>
      ) : (
        <>
          <WorkflowDiagramView
            attempts={attempts}
            diagram={trace.diagram}
            label={t`What the run of version ${version} did`}
            states={states}
          />
          {/* Said only when nothing is drawn either: a run whose tasks the
              diagram shows, but that recorded no action, says enough there. */}
          {trace.steps.length === 0 && trace.tasks.length === 0 ? (
            <Text size="sm" tone="muted">
              {t`It has recorded no step yet.`}
            </Text>
          ) : null}
          {trace.steps.length === 0 ? null : (
            <AgentActivity
              aria-label={stepByStep}
              defaultOpen
              loading={!settled(trace)}
              steps={activitySteps(trace.steps)}
              summary={stepByStep}
            />
          )}
          {trace.truncated ? (
            <Text size="sm" tone="muted">
              {t`Showing the first part of this run`}
            </Text>
          ) : null}
        </>
      )}
    </div>
  );
};

/** Every run, a row each; a press on one opens it, with what it did. */
const RunsTable = ({
  runs,
  names,
  opened,
  onOpen,
}: {
  runs: WorkflowResourceRun[];
  names: Names;
  opened: string | undefined;
  onOpen: (run: WorkflowResourceRun) => void;
}) => {
  const { t } = useLingui();
  const startedBy = useStartedBy(names);
  if (runs.length === 0) {
    return <NoRuns />;
  }
  return (
    <SectionCard aria-label={t`Runs`} density="compact" flush>
      <Table aria-label={t`Runs`}>
        <TableHeader>
          <TableRow>
            <TableHead>{t`Started`}</TableHead>
            <TableHead>{t`Status`}</TableHead>
            <TableHead>{t`Version`}</TableHead>
            <TableHead>{t`Started by`}</TableHead>
            <TableHead
              aria-label={t({
                message: "Open",
                context: "column: a button that opens a run",
              })}
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => {
            const started = formatDateTime(run.createdAt);
            return (
              <TableRow chosen={run.id === opened} key={run.id}>
                <TableCell lead>{started}</TableCell>
                <TableCell>
                  <RunStatusBadge status={run.status} />
                </TableCell>
                <TableCell>{run.version}</TableCell>
                <TableCell>{startedBy(run.principal)}</TableCell>
                <TableCell align="end">
                  <OpenRun
                    onOpen={() => {
                      onOpen(run);
                    }}
                    started={started}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </SectionCard>
  );
};

/** Everything that happened to the workflow, in full. */
const ActivityList = ({
  activity,
  names,
}: {
  activity: Loaded<WorkflowActivity[]>;
  names: Names;
}) => {
  const { t } = useLingui();
  if (activity.state !== "ready") {
    return <NotLoadedState page={activity} />;
  }
  if (activity.data.length === 0) {
    return (
      <Empty size="section">
        <EmptyHeader>
          <EmptyDescription>{t`Nothing has happened yet.`}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const label = t({
    message: "Activity",
    context: "what a workflow did lately",
  });
  return (
    <SectionCard aria-label={label} density="compact" flush>
      <ol {...stylex.props(styles.lines)}>
        {activity.data.map((row) => (
          <ActivityLine key={activityKey(row)} names={names} row={row} />
        ))}
      </ol>
    </SectionCard>
  );
};

export const Traces = ({
  workflow,
  runs,
  activity,
  names,
  admin,
  checkpoint,
  part,
  onPartChange,
  openRun,
  onCloseRun,
}: {
  workflow: string;
  /** The run the address asks to open, by its ID. */
  openRun?: string | undefined;
  /** Clears the run from the address once it is closed. */
  onCloseRun?: () => void;
  /** Whether the reader is one of the organization's admins. */
  admin: boolean;
  runs: Loaded<WorkflowResourceRun[]>;
  activity: Loaded<WorkflowActivity[]>;
  names: Names;
  /** The draft's checkpoint revision, if it has one: what a test runs. */
  checkpoint: number | null;
  part: TracesPart;
  onPartChange: (part: TracesPart) => void;
}) => {
  const { t } = useLingui();
  const [chosen, setChosen] = useState<WorkflowResourceRun | null>(null);
  // The run the address names (Run's "Open the run"), until one is chosen here.
  const opened =
    chosen ??
    (runs.state === "ready"
      ? (runs.data.find((run) => run.id === openRun) ?? null)
      : null);
  // The opened run's status, as its followed trace last said it.
  const [traced, setTraced] = useState<{ runId: string; status: string }>();
  const openedId = opened === null ? undefined : opened.id;
  return (
    <div {...stylex.props(styles.traces)}>
      <ToggleGroup
        aria-label={t`What to show of the traces`}
        onValueChange={(value: unknown[]) => {
          const [next] = value;
          if (next === "runs" || next === "activity") {
            onPartChange(next);
          }
        }}
        value={[part]}
      >
        {/* Quiet, each with how many, as the prototype has them. */}
        <Toggle value="runs">
          {t({ message: "Runs", context: "activity of a workflow: what ran" })}
          <ListedCount
            count={runs.state === "ready" ? runs.data.length : undefined}
            of="runs"
          />
        </Toggle>
        <Toggle value="activity">
          {t({ message: "Activity", context: "what a workflow did lately" })}
          <ListedCount
            count={
              activity.state === "ready" ? activity.data.length : undefined
            }
            of="activity"
          />
        </Toggle>
      </ToggleGroup>
      {/* Kept while Activity shows: a test going on stays followed, and
          the answers typed for it stay. */}
      <div {...stylex.props(styles.traces, part !== "runs" && styles.away)}>
        {checkpoint === null ? null : (
          <ItemTest revision={checkpoint} workflow={workflow} />
        )}
        <RunBeside
          admin={admin}
          names={names}
          onClose={() => {
            setChosen(null);
            onCloseRun?.();
          }}
          opened={opened}
          status={
            traced !== undefined && traced.runId === openedId
              ? traced.status
              : null
          }
          steps={
            opened === null ? null : (
              <RunTraceDetail
                onStatus={(status) => {
                  setTraced({ runId: opened.id, status });
                }}
                runId={opened.id}
                workflow={workflow}
              />
            )
          }
          workflow={workflow}
        >
          {runs.state === "ready" ? (
            <RunsTable
              names={names}
              onOpen={setChosen}
              opened={openedId}
              runs={runs.data}
            />
          ) : (
            <NotLoadedState page={runs} />
          )}
        </RunBeside>
      </div>
      {part === "activity" ? (
        <ActivityList activity={activity} names={names} />
      ) : null}
    </div>
  );
};
