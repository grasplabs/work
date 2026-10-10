import type { App } from "@grasp-os/shared/apps";
import type { RunActivity, WorkflowSummary } from "@grasp-os/shared/workflows";
import { buttonVariants } from "@grasp-os/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { cn } from "@grasp-os/ui/lib/utils";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Await, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { formatDate } from "../format.ts";
import { NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { byState, enginesOf, stateOf, workflowStates } from "./board.ts";
import type { EngineWorkflows, WorkflowState } from "./board.ts";
import { RunsWidget } from "./runs-widget.tsx";
import { CouldBeBetter } from "./signals.tsx";
import type { Signals } from "./signals.tsx";
import { WidgetBlock, WidgetLoading } from "./widget-block.tsx";

// The dashboard's widget board, under what waits on the person, as the
// prototype lays it out (`components/dashboard/widget-board.tsx`): blocks
// of one size, one column, two side by side where the board is wide
// enough. Each opens in full. In a fixed order: where the workflows
// stand, each engine's workflows, the runs this week, and what could be
// better. Each comes
// as it is read, so a slow one holds back no other. The prototype's own
// layout, widgets Grasp makes, moving blocks and adding one, and the
// hours and euros its widgets count, aren't here: core keeps none of it.

/** The engines the person can open, with the workflows. */
export interface EnginesRead {
  apps: App[];
  workflows: WorkflowSummary[];
}

/** What the board reads, each on its own. */
export interface Board {
  workflows: Promise<Loaded<WorkflowSummary[]>>;
  engines: Promise<Loaded<EnginesRead>>;
  runs: Promise<Loaded<RunActivity>>;
  signals: Promise<Loaded<Signals>>;
}

/** Each state's dot: orange where a person is needed, green once it ran, grey before. */
const dotTone: Record<WorkflowState, string> = {
  attention: "bg-status-attention",
  waiting: "border-status-attention bg-card border-2",
  ran: "bg-status-agreed",
  notRun: "bg-input",
};

/** Each state's name. */
const stateNames: Record<WorkflowState, MessageDescriptor> = {
  attention: msg`Needs attention`,
  waiting: msg`Waiting on a person`,
  ran: msg`Ran`,
  notRun: msg`Not run yet`,
};

/** A workflow's dot, in its state's tone. */
const Dot = ({
  state,
  small = false,
}: {
  state: WorkflowState;
  small?: boolean;
}) => (
  <span
    aria-hidden="true"
    className={cn(
      "flex-none rounded-full",
      small ? "size-2" : "size-3",
      dotTone[state]
    )}
  />
);

/** A workflow's dot that opens it, and names it and its engine when pointed at. */
const WorkflowDot = ({ workflow }: { workflow: WorkflowSummary }) => {
  const { t } = useLingui();
  const name = workflow.workflow;
  const engine = workflow.appName;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            aria-label={t`${name} in ${engine}`}
            className="focus-visible:ring-ring flex size-4 items-center justify-center rounded-full outline-none focus-visible:ring-2"
            params={{ app: workflow.app, workflow: name }}
            to="/workflows/$app/$workflow"
          />
        }
      >
        <Dot state={stateOf(workflow)} />
      </TooltipTrigger>
      <TooltipContent>
        <Trans>
          {name} in {engine}
        </Trans>
      </TooltipContent>
    </Tooltip>
  );
};

/** What a widget says when it has nothing to show, with the way to chat, where things are made. */
const NothingYet = ({ children }: { children: ReactNode }) => (
  <div className="flex h-full flex-col items-start justify-center gap-3">
    <p className="text-muted-foreground">{children}</p>
    <Link
      className={buttonVariants({ size: "sm", variant: "outline" })}
      search={{}}
      to="/"
    >
      <Trans>Open Chat</Trans>
    </Link>
  </div>
);

/**
 * The block: a column for each state, the most pressing first, with a dot
 * for each workflow in it, so the picture is how many stand where, and
 * the count under it.
 */
const StateColumns = ({ rows }: { rows: readonly WorkflowSummary[] }) => {
  const { i18n } = useLingui();
  const states = byState(rows);
  return (
    <ol className="grid h-full grid-cols-4 gap-x-2 pt-2">
      {workflowStates.map((state) => {
        const here = states[state];
        const name = i18n._(stateNames[state]);
        return (
          <li className="flex min-w-0 flex-col items-center gap-3" key={state}>
            <ul
              aria-label={name}
              className="flex min-h-0 w-full flex-1 flex-wrap-reverse content-start justify-center gap-1.5 overflow-hidden"
            >
              {here.map((workflow) => (
                <li
                  className="flex"
                  key={`${workflow.app}/${workflow.workflow}`}
                >
                  <WorkflowDot workflow={workflow} />
                </li>
              ))}
            </ul>
            <span className="flex w-full flex-col items-center border-t pt-2 text-center">
              <span className="text-2xl font-medium tabular-nums">
                {here.length}
              </span>
              <span className="text-muted-foreground line-clamp-2 min-h-8 w-full text-xs">
                {name}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
};

/** When a workflow last ran, or that it never did. */
const LastRun = ({ workflow }: { workflow: WorkflowSummary }) =>
  workflow.lastRun === null ? (
    <Trans>Never</Trans>
  ) : (
    formatDate(workflow.lastRun.createdAt)
  );

/** In full: each state with its workflows, each with its engine and when it last ran, opening it. */
const StateSections = ({ rows }: { rows: readonly WorkflowSummary[] }) => {
  const { i18n } = useLingui();
  const states = byState(rows);
  return (
    <div className="flex flex-col">
      {workflowStates.map((state) => {
        const here = states[state];
        if (here.length === 0) {
          return null;
        }
        const name = i18n._(stateNames[state]);
        return (
          <section
            aria-label={name}
            className="grid grid-cols-1 gap-x-6 gap-y-2 border-t py-4 first:border-t-0 first:pt-0 @lg:grid-cols-4"
            key={state}
          >
            <h3 className="flex items-center gap-2.5 self-start">
              <Dot state={state} />
              <span className="font-medium">{name}</span>
              <span className="text-muted-foreground tabular-nums">
                {here.length}
              </span>
            </h3>
            <ul className="flex min-w-0 flex-col gap-2 @lg:col-span-3">
              {here.map((workflow) => (
                <li
                  className="flex items-baseline gap-4"
                  key={`${workflow.app}/${workflow.workflow}`}
                >
                  <Link
                    className="min-w-0 flex-1 truncate hover:underline"
                    params={{ app: workflow.app, workflow: workflow.workflow }}
                    to="/workflows/$app/$workflow"
                  >
                    {workflow.workflow}
                  </Link>
                  <span className="text-muted-foreground hidden max-w-48 truncate @md:block">
                    {workflow.appName}
                  </span>
                  <span className="text-muted-foreground w-24 flex-none text-right tabular-nums">
                    <LastRun workflow={workflow} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
};

/** Where the workflows stand: the person's workflows by state. */
const WorkflowsWidget = ({ rows }: { rows: WorkflowSummary[] }) => {
  const { t } = useLingui();
  const title = t`Workflows`;
  if (rows.length === 0) {
    return (
      <WidgetBlock title={title}>
        <NothingYet>
          <Trans>
            No workflows yet. Describe in chat what should run on its own, and
            Grasp builds it.
          </Trans>
        </NothingYet>
      </WidgetBlock>
    );
  }
  return (
    <WidgetBlock
      count={rows.length}
      full={<StateSections rows={rows} />}
      title={title}
    >
      <StateColumns rows={rows} />
    </WidgetBlock>
  );
};

/** How many of an engine's workflows ran, in words. */
const RanOf = ({ engine }: { engine: EngineWorkflows }) => {
  const { ran } = engine;
  const workflows = engine.workflows.length;
  return (
    <Plural
      one={`${ran} of # workflow ran`}
      other={`${ran} of # workflows ran`}
      value={workflows}
    />
  );
};

/** In full: each engine with its workflows, each with where it stands, opening it. */
const EngineSections = ({
  engines,
}: {
  engines: readonly EngineWorkflows[];
}) => {
  const { i18n } = useLingui();
  return (
    <div className="flex flex-col">
      {engines.map((engine) => (
        <section
          aria-label={engine.app.name}
          className="grid grid-cols-1 gap-x-6 gap-y-2 border-t py-4 first:border-t-0 first:pt-0 @lg:grid-cols-4"
          key={engine.app.id}
        >
          <h3 className="flex min-w-0 flex-col self-start">
            <Link
              className="truncate font-medium hover:underline"
              params={{ engine: engine.app.id }}
              to="/engines/$engine"
            >
              {engine.app.name}
            </Link>
            <span className="text-muted-foreground text-xs">
              <RanOf engine={engine} />
            </span>
          </h3>
          {engine.workflows.length === 0 ? (
            <p className="text-muted-foreground @lg:col-span-3">
              <Trans>No workflows yet</Trans>
            </p>
          ) : (
            <ul className="flex min-w-0 flex-col gap-2 @lg:col-span-3">
              {engine.workflows.map((workflow) => {
                const state = stateOf(workflow);
                return (
                  <li
                    className="flex items-center gap-2.5"
                    key={workflow.workflow}
                  >
                    <Dot small state={state} />
                    <Link
                      className="min-w-0 flex-1 truncate hover:underline"
                      params={{
                        app: workflow.app,
                        workflow: workflow.workflow,
                      }}
                      to="/workflows/$app/$workflow"
                    >
                      {workflow.workflow}
                    </Link>
                    <span className="text-muted-foreground flex-none">
                      {i18n._(stateNames[state])}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
};

/** Each engine the person can open, with how many of its workflows ran. */
const EnginesWidget = ({
  apps,
  rows,
}: {
  apps: App[];
  rows: WorkflowSummary[];
}) => {
  const { t } = useLingui();
  const title = t`Engines`;
  if (apps.length === 0) {
    return (
      <WidgetBlock title={title}>
        <NothingYet>
          <Trans>No engines yet. Engines are made in chat.</Trans>
        </NothingYet>
      </WidgetBlock>
    );
  }
  const engines = enginesOf(apps, rows);
  return (
    <WidgetBlock
      count={engines.length}
      full={<EngineSections engines={engines} />}
      title={title}
    >
      <ul className="flex flex-col">
        {engines.map((engine) => (
          <li
            className="flex items-center gap-3 border-t py-2 first:border-t-0 first:pt-0"
            key={engine.app.id}
          >
            <Link
              className="min-w-0 flex-1 truncate hover:underline"
              params={{ engine: engine.app.id }}
              to="/engines/$engine"
            >
              {engine.app.name}
            </Link>
            <span
              aria-hidden="true"
              className="flex max-w-24 flex-none gap-1 overflow-hidden"
            >
              {engine.workflows.map((workflow) => (
                <Dot key={workflow.workflow} small state={stateOf(workflow)} />
              ))}
            </span>
            <span className="text-muted-foreground flex-none text-xs tabular-nums">
              <RanOf engine={engine} />
            </span>
          </li>
        ))}
      </ul>
    </WidgetBlock>
  );
};

/** A widget whose read failed: its block, saying why. */
const NotRead = ({
  title,
  loaded,
}: {
  title: string;
  loaded: Loaded<unknown>;
}) => (
  <WidgetBlock title={title}>
    <NotLoaded page={loaded} />
  </WidgetBlock>
);

/** The board, each widget in its block as its read comes. */
export const WidgetBoard = ({ board }: { board: Board }) => {
  const { t } = useLingui();
  return (
    <div className="@container">
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
        <Await
          fallback={<WidgetLoading title={t`Workflows`} />}
          promise={board.workflows}
        >
          {(loaded) =>
            loaded.state === "ready" ? (
              <WorkflowsWidget rows={loaded.data} />
            ) : (
              <NotRead loaded={loaded} title={t`Workflows`} />
            )
          }
        </Await>
        <Await
          fallback={<WidgetLoading title={t`Engines`} />}
          promise={board.engines}
        >
          {(loaded) =>
            loaded.state === "ready" ? (
              <EnginesWidget
                apps={loaded.data.apps}
                rows={loaded.data.workflows}
              />
            ) : (
              <NotRead loaded={loaded} title={t`Engines`} />
            )
          }
        </Await>
        <Await
          fallback={<WidgetLoading title={t`Runs this week`} />}
          promise={board.runs}
        >
          {(loaded) =>
            loaded.state === "ready" ? (
              <RunsWidget activity={loaded.data} />
            ) : (
              <NotRead loaded={loaded} title={t`Runs this week`} />
            )
          }
        </Await>
        <CouldBeBetter signals={board.signals} />
      </div>
    </div>
  );
};
