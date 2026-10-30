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
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useEffectEvent, useId, useState } from "react";

import { isTransient } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { ActivityLine, activityKey } from "./activity-bar.tsx";
import type { Names } from "./activity-bar.tsx";
import { followedTrace } from "./followed-trace.ts";
import { ItemTest } from "./item-test.tsx";
import { OpenRun } from "./resource-runs.tsx";
import { RunSheet } from "./run-detail.tsx";
import { runDotOf, runStatusLabels } from "./run-status.ts";
import { WorkflowDiagramView } from "./workflow-diagram.tsx";

// A workflow's Traces, for its builders (prototype `inside-traces.tsx`):
// one thing at a time behind a switch. Runs: a test of the draft on recent
// real items, then every run, a row each; a row opens beside the page with
// when it ran, how it ended and what it returned or why it failed
// (run-detail.tsx), then what the run did laid over its own version's
// diagram, and each step its journal recorded with its state, attempts,
// loop item and error code (`workflowResources.runTrace`). Activity:
// everything that happened to the workflow, in full.

/** Which part of Traces shows. */
export type TracesPart = "runs" | "activity";

/** How often a run still going is read again. */
const followMs = 1500;

/** Ended, or nothing more of it is shown: no need to read it again. */
const settled = (trace: WorkflowRunTrace): boolean =>
  trace.status === "completed" ||
  trace.status === "failed" ||
  trace.status === "cancelled" ||
  trace.detailsRemoved;

/** The words for a step's state, the diagram's own. */
const StepState = ({ state }: { state: TraceState }) => {
  const { t } = useLingui();
  const label = {
    reached: t`Reached`,
    running: t({ message: "Running", context: "an attempt of a step" }),
    waiting: t`Waiting`,
    failed: t`Failed`,
  }[state];
  return (
    <Badge variant={state === "failed" ? "destructive" : "secondary"}>
      {label}
    </Badge>
  );
};

/**
 * Why a step failed, in core's words where core has them (the workflow
 * errors register with `@grasp-os/shared/workflow-resources`, which this
 * page loads), else its code.
 */
const failureOf = (code: string): string => expectedMessageOf(code) ?? code;

/** One step its journal recorded: task, loop item, state, attempts, error. */
const StepLine = ({ step }: { step: TraceStep }) => {
  const { item, attempts, errorCode } = step;
  return (
    <li className="bg-card flex flex-col gap-1 rounded-lg border px-3 py-2">
      <span className="flex flex-wrap items-center gap-2">
        <code className="font-medium">{step.task}</code>
        {item === null ? null : (
          <span className="text-muted-foreground">
            <Trans>Item {item}</Trans>
          </span>
        )}
        <StepState state={step.state} />
        {attempts > 1 ? (
          <Badge variant="outline">
            <Plural one="# attempt" other="# attempts" value={attempts} />
          </Badge>
        ) : null}
      </span>
      <span className="text-muted-foreground text-xs tabular-nums">
        <time dateTime={step.startedAt}>{formatDateTime(step.startedAt)}</time>
      </span>
      {errorCode === null ? null : (
        <span className="text-destructive">{failureOf(errorCode)}</span>
      )}
    </li>
  );
};

/** What run `runId` did, read again until it ends. */
const RunTraceDetail = ({
  workflow,
  runId,
  onStatus,
}: {
  workflow: string;
  runId: string;
  /** The run's status, as each read of its trace says it. */
  onStatus: (status: string) => void;
}) => {
  const core = useCore();
  const { t } = useLingui();
  const [trace, setTrace] = useState<WorkflowRunTrace>();
  const [failure, setFailure] = useState<string>();
  const told = useEffectEvent(onStatus);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Its doors are read once: the run's version, so its diagram, stays.
    let drawn: WorkflowRunTrace["diagram"] | undefined;
    const follow = async (): Promise<void> => {
      try {
        const read = await core.withSession(
          async (session) =>
            await session.workflowResources.runTrace(workflow, runId, {
              doors: drawn === undefined,
            })
        );
        if (stopped) {
          return;
        }
        const followed = followedTrace(read, drawn);
        drawn = followed.diagram;
        setTrace(followed);
        setFailure(undefined);
        told(read.status);
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
    return <ErrorText>{failure}</ErrorText>;
  }
  const { version } = trace;
  const states = new Map(trace.tasks.map(({ task, state }) => [task, state]));
  const attempts = new Map(
    trace.tasks.map(({ task, attempts: made }) => [task, made])
  );
  // How it stands is said over it, with its result (run-detail.tsx).
  return (
    <div className="flex flex-col gap-6">
      <ErrorText>{failure}</ErrorText>
      {trace.detailsRemoved ? (
        <p className="text-muted-foreground">
          <Trans>
            The details of this run were removed when its retention ended.
          </Trans>
        </p>
      ) : (
        <>
          <WorkflowDiagramView
            attempts={attempts}
            diagram={trace.diagram}
            label={t`What the run of version ${version} did`}
            states={states}
          />
          <section className="flex flex-col gap-2">
            <h3 className="text-muted-foreground">
              {t({
                message: "Step by step",
                context: "the steps of one run, one under the other",
              })}
            </h3>
            {trace.steps.length === 0 ? (
              <p className="text-muted-foreground">
                <Trans>It has recorded no step yet.</Trans>
              </p>
            ) : (
              <ol className="flex flex-col gap-2">
                {trace.steps.map((step) => (
                  <StepLine key={step.ordinal} step={step} />
                ))}
              </ol>
            )}
            {trace.complete ? null : (
              <p className="text-muted-foreground">
                <Trans>
                  It recorded more steps than one read shows: the latest are
                  left out.
                </Trans>
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
};

/** Every run, a row each; a press on one opens it, with what it did. */
const RunsTable = ({
  runs,
  names,
  onOpen,
}: {
  runs: WorkflowResourceRun[];
  names: Names;
  onOpen: (run: WorkflowResourceRun) => void;
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
      </div>
      <p className="text-muted-foreground" id={captionId}>
        <Trans>The latest runs, newest first.</Trans>
      </p>
    </div>
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
  if (activity.state !== "ready") {
    return <NotLoadedState page={activity} />;
  }
  if (activity.data.length === 0) {
    return (
      <p className="bg-card text-muted-foreground rounded-xl border px-4 py-6 text-center">
        <Trans>Nothing has happened yet.</Trans>
      </p>
    );
  }
  return (
    <ol className="bg-card flex flex-col rounded-xl border px-4 py-2">
      {activity.data.map((row) => (
        <ActivityLine key={activityKey(row)} names={names} row={row} />
      ))}
    </ol>
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
}: {
  workflow: string;
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
  const [opened, setOpened] = useState<WorkflowResourceRun | null>(null);
  // The opened run's status, as its followed trace last said it.
  const [traced, setTraced] = useState<{ runId: string; status: string }>();
  return (
    <div className="flex flex-col gap-6">
      <ToggleGroup
        aria-label={t`What to show of the traces`}
        onValueChange={(value: unknown[]) => {
          const [next] = value;
          if (next === "runs" || next === "activity") {
            onPartChange(next);
          }
        }}
        value={[part]}
        variant="outline"
      >
        <ToggleGroupItem value="runs">
          {t({ message: "Runs", context: "activity of a workflow: what ran" })}
        </ToggleGroupItem>
        <ToggleGroupItem value="activity">
          {t({ message: "Activity", context: "what a workflow did lately" })}
        </ToggleGroupItem>
      </ToggleGroup>
      {/* Kept while Activity shows: a test going on stays followed, and
          the answers typed for it stay. */}
      <div className="flex flex-col gap-6" hidden={part !== "runs"}>
        {checkpoint === null ? null : (
          <ItemTest revision={checkpoint} workflow={workflow} />
        )}
        {runs.state === "ready" ? (
          <RunsTable names={names} onOpen={setOpened} runs={runs.data} />
        ) : (
          <NotLoadedState page={runs} />
        )}
      </div>
      {part === "activity" ? (
        <ActivityList activity={activity} names={names} />
      ) : null}
      <RunSheet
        admin={admin}
        names={names}
        onClose={() => {
          setOpened(null);
        }}
        opened={opened}
        status={
          traced !== undefined && traced.runId === opened?.id
            ? traced.status
            : null
        }
        steps={
          opened === null ? null : (
            <section className="flex flex-col gap-3">
              <h3 className="text-muted-foreground">
                <Trans>What it did</Trans>
              </h3>
              <RunTraceDetail
                onStatus={(status) => {
                  setTraced({ runId: opened.id, status });
                }}
                runId={opened.id}
                workflow={workflow}
              />
            </section>
          )
        }
        workflow={workflow}
      />
    </div>
  );
};
