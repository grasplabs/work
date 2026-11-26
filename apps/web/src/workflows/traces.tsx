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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { Text } from "@grasp-os/ui/components/text";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@grasp-os/ui/components/trace";
import type { TraceLineStatus } from "@grasp-os/ui/components/trace";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

import { isTransient } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { activityKey, activityText } from "./activity-words.ts";
import type { Names } from "./activity-words.ts";
import { ItemTest } from "./item-test.tsx";
import { ListedCount } from "./listed-count.tsx";
import { WorkflowRunsTable } from "./resource-runs.tsx";
import { SectionCard } from "./section-card.tsx";
import { WorkflowDiagramView } from "./workflow-diagram.tsx";

// A workflow's Traces, for its builders (prototype `inside-traces.tsx`):
// one thing at a time behind a switch. Runs: a test of the draft on recent
// real items, then every run, a row each, each opening the run's page
// (run-page.tsx), whose Workshop shows what the run did laid over its own
// version's diagram, and each step its journal recorded with its state,
// attempts, loop item and error code (`workflowResources.runTrace`), as
// Damsko's Trace (`RunTraceDetail`). Activity: everything that happened to
// the workflow, in full.

/** Which part of Traces shows. */
export type TracesPart = "runs" | "activity";

/** How often a run still going is read again. */
const followMs = 1500;

const styles = stylex.create({
  traces: { display: "grid", rowGap: space["6"], minWidth: 0 },
  // A run's steps, in the card of its "What it did".
  did: {
    display: "grid",
    rowGap: space["4"],
    paddingBlock: space["3"],
    paddingInline: space.sidePanelPadding,
    minWidth: 0,
  },
});

/** Ended, or nothing more of it is shown: no need to read it again. */
const settled = (trace: WorkflowRunTrace): boolean =>
  trace.status === "completed" ||
  trace.status === "failed" ||
  trace.status === "cancelled" ||
  trace.detailsRemoved;

/** A step's state, as a Trace's line says it: done has none. */
const lineStatuses: Readonly<Record<TraceState, TraceLineStatus | undefined>> =
  {
    reached: undefined,
    running: "running",
    waiting: "pending",
    failed: "error",
  };

/**
 * Why a step failed, in core's words where core has them (the workflow
 * errors register with `@grasp-os/shared/workflow-resources`, which this
 * page loads), else its code.
 */
const failureOf = (code: string): string => expectedMessageOf(code) ?? code;

/**
 * The steps its journal recorded, one line each on Damsko's Trace: the
 * task, with its loop item, its attempts and when it started in the quiet
 * note after it, and why it failed after that. Folded under one line that
 * names them all, open at first, its line running while the run goes on.
 */
const StepByStep = ({
  steps,
  going,
  label,
}: {
  steps: readonly TraceStep[];
  going: boolean;
  label: string;
}) => {
  const { t } = useLingui();
  return (
    <Trace>
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>
          <TraceLine {...(going ? { status: "running" as const } : {})}>
            <TraceTitle>{label}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            {steps.map((step) => {
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
              const status = lineStatuses[step.state];
              return (
                <TraceLine
                  key={step.ordinal}
                  {...(status === undefined ? {} : { status })}
                >
                  <TraceIcon />
                  <TraceTitle>{step.task}</TraceTitle>
                  <TraceDescription>{notes.join(" · ")}</TraceDescription>
                  {errorCode === null ? null : (
                    <TraceDescription>{failureOf(errorCode)}</TraceDescription>
                  )}
                </TraceLine>
              );
            })}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
};

/** What run `runId` did, read again until it ends. */
export const RunTraceDetail = ({
  workflow,
  runId,
}: {
  workflow: string;
  runId: string;
}) => {
  const core = useCore();
  const { t } = useLingui();
  const [trace, setTrace] = useState<WorkflowRunTrace>();
  const [failure, setFailure] = useState<string>();

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
        <Text color="muted" size="sm">
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
            <Text color="muted" size="sm">
              {t`It has recorded no step yet.`}
            </Text>
          ) : null}
          {trace.steps.length === 0 ? null : (
            <StepByStep
              going={!settled(trace)}
              label={stepByStep}
              steps={trace.steps}
            />
          )}
          {trace.truncated ? (
            <Text color="muted" size="sm">
              {t`Showing the first part of this run`}
            </Text>
          ) : null}
        </>
      )}
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
  const { t } = useLingui();
  if (activity.state !== "ready") {
    return <NotLoadedState page={activity} />;
  }
  if (activity.data.length === 0) {
    return (
      <Empty>
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
    <SectionCard aria-label={label} flush>
      <ItemGroup separated aria-label={label}>
        {activity.data.map((row) => (
          <Item key={activityKey(row)} size="sm">
            <ItemContent>
              <ItemTitle>{activityText(row, names)}</ItemTitle>
              <ItemDescription>
                <time dateTime={row.at}>{formatDateTime(row.at)}</time>
              </ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    </SectionCard>
  );
};

export const Traces = ({
  workflow,
  runs,
  activity,
  names,
  testable,
  part,
  onPartChange,
}: {
  workflow: string;
  runs: Loaded<WorkflowResourceRun[]>;
  activity: Loaded<WorkflowActivity[]>;
  names: Names;
  /** The draft's revision while it passes: what a test runs. */
  testable: number | null;
  part: TracesPart;
  onPartChange: (part: TracesPart) => void;
}) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.traces)}>
      <Tabs
        onValueChange={(next) => {
          if (next === "runs" || next === "activity") {
            onPartChange(next);
          }
        }}
        value={part}
      >
        <TabsList aria-label={t`What to show of the traces`} variant="default">
          {/* The bar's Runs view already counts the runs. */}
          <TabsTrigger value="runs">
            {t({
              message: "Runs",
              context: "activity of a workflow: what ran",
            })}
          </TabsTrigger>
          <TabsTrigger value="activity">
            {t({ message: "Activity", context: "what a workflow did lately" })}
            <ListedCount
              count={
                activity.state === "ready" ? activity.data.length : undefined
              }
              of="activity"
            />
          </TabsTrigger>
        </TabsList>
        {/* Kept while Activity shows: a test going on stays followed, and
            the answers typed for it stay. */}
        <TabsContent keepMounted value="runs">
          <div {...stylex.props(styles.traces)}>
            {testable === null ? null : (
              <ItemTest revision={testable} workflow={workflow} />
            )}
            {runs.state === "ready" ? (
              <WorkflowRunsTable
                names={names}
                runs={runs.data}
                workflow={workflow}
              />
            ) : (
              <NotLoadedState page={runs} />
            )}
          </div>
        </TabsContent>
        <TabsContent value="activity">
          <ActivityList activity={activity} names={names} />
        </TabsContent>
      </Tabs>
    </div>
  );
};
