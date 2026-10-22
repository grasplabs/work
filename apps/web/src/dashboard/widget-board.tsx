import type { App } from "@grasp-os/shared/apps";
import type { StandardWidgetId } from "@grasp-os/shared/dashboard";
import type { ModelMonthSpend } from "@grasp-os/shared/models";
import type {
  AppWorkflowSummary as WorkflowSummary,
  RunActivity,
} from "@grasp-os/shared/workflows";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
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
import { GripVerticalIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { flushSync } from "react-dom";

import { ErrorText } from "../error-text.tsx";
import { formatDate } from "../format.ts";
import { NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { byState, enginesOf, stateOf, workflowStates } from "./board.ts";
import type { Engines, EngineWorkflows, WorkflowState } from "./board.ts";
import {
  addWidget,
  differsFromDefault,
  missingWidgets,
  moveWidget,
  placeWidget,
  removeWidget,
  slotAt,
} from "./layout.ts";
import type { GridShape } from "./layout.ts";
import type { WorkReturns } from "./returns.ts";
import { RunsWidget } from "./runs-widget.tsx";
import { CouldBeBetter } from "./signals.tsx";
import type { Signals } from "./signals.tsx";
import { SpendWidget } from "./spend-widget.tsx";
import {
  GoalListView,
  ReturnChartView,
  TeamListView,
  fills,
} from "./standard-widgets.tsx";
import {
  BlockButton,
  WidgetBlock,
  WidgetControls,
  WidgetLoading,
  useFull,
} from "./widget-block.tsx";

// The dashboard's widget board, under what waits on the person, as the
// prototype's (`components/dashboard/widget-board.tsx`, `widget-add.tsx`,
// `widget-parts.tsx`): blocks of one size, one column, two side by side
// where the board is wide enough. Each opens in full. Each person has
// their own board: the widgets on it in their order, saved in core whole
// with each change. It begins with the prototype's four (what the work
// returns a month, the board's goals, how far each team is with AI,
// where the workflows stand), then each engine's workflows, the runs this
// week and what could be better. There is no mode for changing it: a
// block pointed at shows its grip, to drag it (or by its title, with the
// mouse) or move it with the arrow keys, and the button that takes it
// off; the last place is an empty card that adds one; and a quiet line
// under the board puts it back as it began. Each comes as it is read, so
// a slow one holds back no other.
//
// What the prototype's board has besides: Grasp makes a widget from what
// someone asks, or changes one, from the empty card and a block's
// sparkle, drawing it in dots meanwhile, and the blocks glide out of each
// other's way. Making widgets needs the model gateway behind it, and
// comes with it; until then the empty card puts back a widget that was
// taken off. The return, goals and teams widgets count hours, stages and
// goals core doesn't keep yet: they show what the prototype shows with
// nothing to count (`returns.ts`).

/** The engines the person can open, with the workflows. */
export interface EnginesRead {
  apps: App[];
  workflows: WorkflowSummary[];
}

/** What the board reads, each on its own, and the person's order of it. */
export interface Board {
  /** The widgets on the person's board, in order. */
  layout: readonly StandardWidgetId[];
  /** The widgets Grasp offers them, as their board begins (`offeredWidgets`). */
  offered: readonly StandardWidgetId[];
  /** What the return, goals and teams widgets count. */
  returns: WorkReturns;
  workflows: Promise<Loaded<WorkflowSummary[]>>;
  engines: Promise<Loaded<EnginesRead>>;
  runs: Promise<Loaded<RunActivity>>;
  signals: Promise<Loaded<Signals>>;
  /** What the models cost this month: admins only, the only ones offered its widget. */
  spend: Promise<Loaded<ModelMonthSpend>> | undefined;
}

/** Each state's dot, as the prototype's workflow dots are painted: orange where a person is needed, green once it ran, grey before. */
const dotFills: Record<WorkflowState, string> = {
  attention: fills.attention,
  waiting: "border-2 border-status-attention bg-card",
  ran: fills.live,
  notRun: fills.rest,
};

/** Each state's mark, as the prototype's marks: a little smaller than its dot. */
const markFills: Record<WorkflowState, string> = {
  attention: "bg-status-attention",
  waiting: "border border-status-attention bg-card",
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

/** A workflow's mark, in its state's tone. */
const StateMark = ({ state }: { state: WorkflowState }) => (
  <span
    aria-hidden="true"
    className={cn("size-2 flex-none rounded-full", markFills[state])}
  />
);

/** A workflow's dot that opens it, and names it and its engine when pointed at. */
const WorkflowDot = ({ workflow }: { workflow: WorkflowSummary }) => {
  const { t } = useLingui();
  const name = workflow.workflow;
  const domain = workflow.appName;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            aria-label={t`${name} in ${domain}`}
            className="focus-visible:ring-ring flex size-4 items-center justify-center rounded-full outline-none focus-visible:ring-2"
            params={{ app: workflow.app, workflow: name }}
            to="/workflows/$app/$workflow"
          />
        }
      >
        <span
          className={cn("size-3 rounded-full", dotFills[stateOf(workflow)])}
        />
      </TooltipTrigger>
      <TooltipContent side="right" variant="quiet">
        <span className="flex flex-col text-left">
          <span className="text-foreground font-medium">{name}</span>
          <span>{domain}</span>
        </span>
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

/** When a workflow last ran, or that it never did. */
const LastRun = ({ workflow }: { workflow: WorkflowSummary }) =>
  workflow.lastRun === null ? (
    <Trans>Never</Trans>
  ) : (
    formatDate(workflow.lastRun.createdAt)
  );

/**
 * The workflows, as the prototype's (`WorkflowTabsView`), by where each
 * stands in work: a column for each state, the most pressing first, with
 * a dot for each workflow in it, so the picture is how many stand where,
 * and the count under it. In full, every state as a row: its name and how
 * many stand there on the left, its workflows on the right, one line
 * each with its engine and when it last ran. The prototype's columns are
 * the five steps on the way to live, which core doesn't keep.
 */
const WorkflowTabsView = ({ rows }: { rows: readonly WorkflowSummary[] }) => {
  const { i18n } = useLingui();
  const full = useFull();
  const states = byState(rows);
  if (!full) {
    return (
      <ol className="grid h-full grid-cols-4 gap-x-2 pt-2">
        {workflowStates.map((state) => {
          const here = states[state];
          const name = i18n._(stateNames[state]);
          return (
            <li
              className="flex min-w-0 flex-col items-center gap-3"
              key={state}
            >
              <ul
                aria-label={name}
                className="flex min-h-0 flex-1 flex-col-reverse items-center gap-1.5"
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
                <span
                  className="text-muted-foreground line-clamp-2 min-h-8 w-full text-xs wrap-anywhere hyphens-auto"
                  lang={i18n.locale}
                >
                  {name}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    );
  }
  return (
    <ol className="flex flex-col">
      {workflowStates.map((state) => {
        const here = states[state];
        if (here.length === 0) {
          return null;
        }
        const name = i18n._(stateNames[state]);
        return (
          <li
            className="@lg:stage-columns grid grid-cols-1 gap-x-6 gap-y-2 border-t py-4 first:border-t-0 first:pt-0"
            key={state}
          >
            <span className="flex items-center gap-2.5 self-start">
              <StateMark state={state} />
              <span className="font-medium">{name}</span>
              <span className="text-muted-foreground tabular-nums">
                {here.length}
              </span>
            </span>
            <ul aria-label={name} className="flex min-w-0 flex-col gap-2">
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
                  <span className="text-muted-foreground hidden max-w-48 flex-none truncate @md:block">
                    {workflow.appName}
                  </span>
                  <span className="text-muted-foreground hidden flex-none tabular-nums @md:block">
                    <LastRun workflow={workflow} />
                  </span>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ol>
  );
};

/** Where the workflows stand: the person's workflows by state. */
const WorkflowsWidget = ({ rows }: { rows: WorkflowSummary[] }) => {
  const { t } = useLingui();
  return (
    <WidgetBlock full={<WorkflowTabsView rows={rows} />} title={t`Workflows`}>
      <WorkflowTabsView rows={rows} />
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

/** How many engines there are with no workflow to show, if any. */
const Others = ({ count }: { count: number }) =>
  count === 0 ? null : (
    <p className="text-muted-foreground border-t pt-3 text-xs first:border-t-0 first:pt-0">
      <Plural
        one="# more domain with no workflows to show"
        other="# more domains with no workflows to show"
        value={count}
      />
    </p>
  );

/** In full: each engine with its workflows, each with where it stands, opening it. */
const EngineSections = ({ engines, others }: Engines) => {
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
              to="/domains/$engine"
            >
              {engine.app.name}
            </Link>
            <span className="text-muted-foreground text-xs">
              <RanOf engine={engine} />
            </span>
          </h3>
          <ul className="flex min-w-0 flex-col gap-2 @lg:col-span-3">
            {engine.workflows.map((workflow) => {
              const state = stateOf(workflow);
              return (
                <li
                  className="flex items-center gap-2.5"
                  key={workflow.workflow}
                >
                  <StateMark state={state} />
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
        </section>
      ))}
      <Others count={others} />
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
  const title = t`Domains`;
  if (apps.length === 0) {
    return (
      <WidgetBlock title={title}>
        <NothingYet>
          <Trans>No domains yet. Domains are made in chat.</Trans>
        </NothingYet>
      </WidgetBlock>
    );
  }
  const { engines, others } = enginesOf(apps, rows);
  return (
    <WidgetBlock
      full={<EngineSections engines={engines} others={others} />}
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
              to="/domains/$engine"
            >
              {engine.app.name}
            </Link>
            <span
              aria-hidden="true"
              className="flex max-w-24 flex-none gap-1 overflow-hidden"
            >
              {engine.workflows.map((workflow) => (
                <StateMark key={workflow.workflow} state={stateOf(workflow)} />
              ))}
            </span>
            <span className="text-muted-foreground flex-none text-xs tabular-nums">
              <RanOf engine={engine} />
            </span>
          </li>
        ))}
      </ul>
      <Others count={others} />
    </WidgetBlock>
  );
};

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

/** Each widget's name: its block's title, and how the add card lists it. */
const widgetTitles: Record<StandardWidgetId, MessageDescriptor> = {
  return: msg({
    message: "Return a month",
    context: "dashboard widget: what the work costs now and what returns",
  }),
  goals: msg({ message: "Board goals", context: "dashboard widget" }),
  teams: msg({
    message: "Teams with AI",
    context: "dashboard widget: how far each team is with AI",
  }),
  workflows: msg`Workflows`,
  engines: msg`Domains`,
  runs: msg`Runs this week`,
  signals: msg`Could be better`,
  spend: msg({ message: "AI spend this month", context: "dashboard widget" }),
};

/** Each widget in its block, titled `title`, as its read comes. */
const widgetBlocks: Record<
  StandardWidgetId,
  (board: Board, title: string) => ReactNode
> = {
  return: ({ returns }, title) => (
    <WidgetBlock full={<ReturnChartView rows={returns.rows} />} title={title}>
      <ReturnChartView rows={returns.rows} />
    </WidgetBlock>
  ),
  goals: ({ returns }, title) => (
    <WidgetBlock full={<GoalListView goals={returns.goals} />} title={title}>
      <GoalListView goals={returns.goals} />
    </WidgetBlock>
  ),
  teams: ({ returns }, title) => (
    <WidgetBlock
      full={<TeamListView rows={returns.rows} teams={returns.teams} />}
      title={title}
    >
      <TeamListView rows={returns.rows} teams={returns.teams} />
    </WidgetBlock>
  ),
  workflows: (board, title) => (
    <Await fallback={<WidgetLoading title={title} />} promise={board.workflows}>
      {(loaded) =>
        loaded.state === "ready" ? (
          <WorkflowsWidget rows={loaded.data} />
        ) : (
          <NotRead loaded={loaded} title={title} />
        )
      }
    </Await>
  ),
  engines: (board, title) => (
    <Await fallback={<WidgetLoading title={title} />} promise={board.engines}>
      {(loaded) =>
        loaded.state === "ready" ? (
          <EnginesWidget apps={loaded.data.apps} rows={loaded.data.workflows} />
        ) : (
          <NotRead loaded={loaded} title={title} />
        )
      }
    </Await>
  ),
  runs: (board, title) => (
    <Await fallback={<WidgetLoading title={title} />} promise={board.runs}>
      {(loaded) =>
        loaded.state === "ready" ? (
          <RunsWidget activity={loaded.data} />
        ) : (
          <NotRead loaded={loaded} title={title} />
        )
      }
    </Await>
  ),
  signals: (board) => <CouldBeBetter signals={board.signals} />,
  spend: (board, title) =>
    board.spend === undefined ? null : (
      <Await fallback={<WidgetLoading title={title} />} promise={board.spend}>
        {(loaded) =>
          loaded.state === "ready" ? (
            <SpendWidget spend={loaded.data} title={title} />
          ) : (
            <NotRead loaded={loaded} title={title} />
          )
        }
      </Await>
    ),
};

/**
 * A block's own buttons, until it is pointed at: there, but unseen. Seen
 * with the keys in the block, and always where there is no pointer to
 * point with.
 */
const atHand =
  "flex opacity-0 transition-opacity group-focus-within/block:opacity-100 group-hover/block:opacity-100 pointer-coarse:opacity-100";

/** How far a press has to move before it is a drag, in pixels: less is a press. */
const dragFrom = 6;

/** The places one arrow key moves a block, with the board's columns. */
const keySteps = (key: string, columns: number): number | undefined => {
  if (key === "ArrowLeft") {
    return -1;
  }
  if (key === "ArrowRight") {
    return 1;
  }
  if (key === "ArrowUp") {
    return -columns;
  }
  return key === "ArrowDown" ? columns : undefined;
};

/** A length as the browser computes it, in pixels: what comes before its unit. */
const pixels = /px$/u;

/** The grid of blocks as it stands on screen now; null while it has none. */
const shapeOf = (grid: HTMLElement | null): GridShape | null => {
  const cells = grid?.querySelectorAll<HTMLElement>("[data-widget]") ?? [];
  const [first] = cells;
  if (grid === null || first === undefined) {
    return null;
  }
  const box = grid.getBoundingClientRect();
  const style = getComputedStyle(grid);
  return {
    left: box.left,
    top: box.top,
    columns: style.gridTemplateColumns.split(" ").filter(Boolean).length,
    width: first.offsetWidth,
    height: first.offsetHeight,
    gap: Number(style.columnGap.replace(pixels, "")) || 0,
    count: cells.length,
  };
};

/**
 * A press on a block that may become a drag: the block, where the press
 * began, whether it moved far enough to be one, the board before it, and
 * the order it has made so far.
 */
interface Press {
  id: StandardWidgetId;
  /** The pointer that took hold of it: another one, a second finger, is ignored. */
  pointer: number;
  fromX: number;
  fromY: number;
  moved: boolean;
  before: readonly StandardWidgetId[];
  order: readonly StandardWidgetId[];
}

/**
 * What a block is moved by: the place to take hold of it, though the
 * mouse can drag it by its title too (with a finger, the only place), and
 * the way to move it with the keys, one place with left and right, one
 * row with up and down.
 */
const Grip = ({
  id,
  title,
  onKeyDown,
}: {
  id: StandardWidgetId;
  title: string;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) => {
  const { t } = useLingui();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={t`Move ${title}: drag it, or use the arrow keys`}
            className="cursor-grab touch-none"
            data-grip={id}
            onKeyDown={onKeyDown}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <GripVerticalIcon />
      </TooltipTrigger>
      <TooltipContent>{t`Move`}</TooltipContent>
    </Tooltip>
  );
};

/**
 * Where a widget is added, as the prototype's (`widget-add.tsx`): the last
 * place on the board, always there, an empty card as large as a block with
 * nothing in it but a plus. In the prototype a press asks Grasp, in the
 * chat box, what the widget should be, and Grasp sketches it in dots
 * meanwhile; that comes with making widgets. Until then a press lists the
 * widgets that were taken off the board, each going last, and the card
 * can't be pressed while every one is on it.
 */
const AddTile = ({
  missing,
  onAdd,
}: {
  missing: readonly StandardWidgetId[];
  onAdd: (id: StandardWidgetId) => void;
}) => {
  const { t, i18n } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative h-80 min-w-0">
      <div className="relative h-full">
        <Popover onOpenChange={setOpen} open={open}>
          <PopoverTrigger
            render={
              <button
                aria-label={t`Add a widget`}
                className="peer border-input hover:border-ring focus-visible:ring-ring size-full rounded-xl border border-dashed transition-colors outline-none focus-visible:ring-2 disabled:pointer-events-none"
                disabled={missing.length === 0}
                type="button"
              />
            }
          />
          <PopoverContent className="w-64">
            <PopoverHeader>
              <PopoverTitle>
                <Trans>Add a widget</Trans>
              </PopoverTitle>
            </PopoverHeader>
            <ul className="flex flex-col">
              {missing.map((id) => (
                <li key={id}>
                  <Button
                    className="w-full justify-start"
                    onClick={() => {
                      setOpen(false);
                      onAdd(id);
                    }}
                    variant="ghost"
                  >
                    {i18n._(widgetTitles[id])}
                  </Button>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
        {/* The plus stands in the middle of the card, and is always seen. */}
        <PlusIcon
          aria-hidden="true"
          className="text-muted-foreground peer-hover:text-foreground peer-focus-visible:text-foreground pointer-events-none absolute top-1/2 left-1/2 size-5 -translate-1/2 transition-colors"
        />
      </div>
    </div>
  );
};

/**
 * Putting the board back as it began: one quiet line under it, only when
 * it is not as it began.
 */
const ResetLine = ({ onReset }: { onReset: () => void }) => (
  <div className="flex justify-center pt-3 opacity-70 transition-opacity focus-within:opacity-100 hover:opacity-100">
    <Button onClick={onReset} size="xs" variant="link">
      <Trans>Back to how it began</Trans>
    </Button>
  </div>
);

/**
 * The page's saves of the layout, one queue for every board this page
 * shows: one at a time, in order, and only the latest layout made is sent,
 * so a board left with saves still to go never sends them over a newer
 * board's.
 */
const layoutSaves: { queue: Promise<void>; made: number } = {
  queue: Promise.resolve(),
  made: 0,
};

/** How a layout's save ended: saved, refused, or not sent, a newer layout made before its turn. */
type SaveEnd = "saved" | "refused" | "refusedSinceChanged" | "skipped";

/**
 * Sends a layout (`send`, true when core took it) once the saves before
 * it end, unless a newer one was made meanwhile.
 */
const queueLayoutSave = async (
  send: () => Promise<boolean>
): Promise<SaveEnd> => {
  layoutSaves.made += 1;
  const { made } = layoutSaves;
  const previous = layoutSaves.queue;
  const saving = (async (): Promise<SaveEnd> => {
    await previous;
    if (layoutSaves.made !== made) {
      return "skipped";
    }
    if (await send()) {
      return "saved";
    }
    return layoutSaves.made === made ? "refused" : "refusedSinceChanged";
  })();
  layoutSaves.queue = (async () => {
    await saving;
  })();
  return await saving;
};

/**
 * The board, each widget in its block as its read comes, in the person's
 * order. Each change shows at once and is saved whole; one core refuses
 * goes back, saying why.
 */
export const WidgetBoard = ({ board }: { board: Board }) => {
  const { t, i18n } = useLingui();
  const { run } = useCoreAction();
  const [widgets, setWidgets] = useState(board.layout);
  const [failure, setFailure] = useState<string>();
  const [announcement, setAnnouncement] = useState("");
  const [dragged, setDragged] = useState<StandardWidgetId | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const press = useRef<Press | null>(null);
  /** Ends the drag under way, if any, without saving it. */
  const stopDrag = useRef<(() => void) | null>(null);
  /** The layout core last took: what a refused save goes back to. */
  const confirmed = useRef(board.layout);
  const titleOf = (id: StandardWidgetId) => i18n._(widgetTitles[id]);

  // A save that core refuses, with no later one to come, puts the board
  // back to what core last took: never to a layout only this page had.
  const save = async (next: readonly StandardWidgetId[], said: string) => {
    setWidgets(next);
    setFailure(undefined);
    setAnnouncement(said);
    const end = await queueLayoutSave(
      async () =>
        (await run(
          async (session) => {
            await session.dashboard.saveLayout({ widgets: [...next] });
            return true;
          },
          (reason) => {
            setFailure(reason);
          }
        )) === true
    );
    if (end === "saved") {
      confirmed.current = next;
    } else if (end === "refused") {
      // A drag under way began from the layout core just refused: it
      // ends here, so it can neither put that back nor save on top of it.
      stopDrag.current?.();
      setDragged(null);
      setWidgets(confirmed.current);
    }
  };

  // A drag the board is left in the middle of ends there, unsaved.
  useEffect(
    () => () => {
      stopDrag.current?.();
    },
    []
  );

  const placeSaid = (
    id: StandardWidgetId,
    order: readonly StandardWidgetId[]
  ) => {
    const title = titleOf(id);
    const place = order.indexOf(id) + 1;
    const count = order.length;
    return t`${title} is now in place ${place} of ${count}.`;
  };

  const moveByKey = (
    id: StandardWidgetId,
    event: KeyboardEvent<HTMLButtonElement>
  ) => {
    const by = keySteps(event.key, shapeOf(grid.current)?.columns ?? 1);
    if (by === undefined) {
      return;
    }
    event.preventDefault();
    const next = moveWidget(widgets, id, by);
    if (next === widgets) {
      return;
    }
    // Moving the block may move the grip out of the document and back,
    // which takes the keys off it: they go back to it at once.
    const grip = event.currentTarget;
    flushSync(() => {
      void save(next, placeSaid(id, next));
    });
    grip.focus();
  };

  const remove = (id: StandardWidgetId) => {
    const title = titleOf(id);
    void save(
      removeWidget(widgets, id),
      t`${title} removed from the dashboard.`
    );
  };

  const add = (id: StandardWidgetId) => {
    const title = titleOf(id);
    void save(addWidget(widgets, id), t`${title} added to the dashboard.`);
  };

  const reset = () => {
    void save(board.offered, t`The dashboard is back to how it began.`);
  };

  // A drag follows the pointer over the whole page, so a block that moves
  // under it while it is dragged doesn't lose it.
  const startDrag = (
    id: StandardWidgetId,
    event: PointerEvent<HTMLElement>
  ) => {
    if (event.button !== 0 || !(event.target instanceof Element)) {
      return;
    }
    const byGrip = event.target.closest("[data-grip]") !== null;
    // The mouse takes a block by its title too, never by one of its buttons
    // or links.
    const byTitle =
      event.pointerType === "mouse" &&
      event.target.closest("header") !== null &&
      event.target.closest("button, a") === null;
    if (!byGrip && !byTitle) {
      return;
    }
    // One drag at a time: another finger pressing meanwhile takes nothing.
    if (press.current !== null) {
      return;
    }
    press.current = {
      id,
      pointer: event.pointerId,
      fromX: event.clientX,
      fromY: event.clientY,
      moved: false,
      before: widgets,
      order: widgets,
    };
    const follow = (moved: globalThis.PointerEvent) => {
      const held = press.current;
      if (held === null || moved.pointerId !== held.pointer) {
        return;
      }
      if (!held.moved) {
        const far = Math.hypot(
          moved.clientX - held.fromX,
          moved.clientY - held.fromY
        );
        if (far < dragFrom) {
          return;
        }
        held.moved = true;
        setDragged(held.id);
      }
      const shape = shapeOf(grid.current);
      const slot =
        shape === null ? null : slotAt(shape, moved.clientX, moved.clientY);
      if (slot !== null) {
        held.order = placeWidget(held.order, held.id, slot);
        setWidgets(held.order);
      }
    };
    const stop = () => {
      window.removeEventListener("pointermove", follow);
      // oxlint-disable-next-line no-use-before-define -- each takes the other off
      window.removeEventListener("pointerup", drop);
      // oxlint-disable-next-line no-use-before-define -- each takes the other off
      window.removeEventListener("pointercancel", cancel);
      press.current = null;
      stopDrag.current = null;
    };
    const drop = (ended: globalThis.PointerEvent) => {
      const held = press.current;
      if (held === null || ended.pointerId !== held.pointer) {
        return;
      }
      stop();
      setDragged(null);
      if (held.moved && held.order !== held.before) {
        void save(held.order, placeSaid(held.id, held.order));
      }
    };
    // A drag the browser cancels (a touch taken over by a scroll, a pen
    // lifted out of range) was never dropped: the board goes back, unsaved.
    const cancel = (ended: globalThis.PointerEvent) => {
      const held = press.current;
      if (held === null || ended.pointerId !== held.pointer) {
        return;
      }
      stop();
      setDragged(null);
      if (held.moved) {
        setWidgets(held.before);
      }
    };
    stopDrag.current = stop;
    window.addEventListener("pointermove", follow);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", cancel);
  };

  const missing = missingWidgets(widgets, board.offered);
  return (
    <div className="@container">
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2" ref={grid}>
        {widgets.map((id) => {
          const title = titleOf(id);
          const dragging = dragged === id;
          return (
            <div
              className={cn(
                "group/block relative h-80 min-w-0",
                dragging && "z-30 cursor-grabbing select-none"
              )}
              data-widget={id}
              key={id}
              onPointerDown={(event) => {
                startDrag(id, event);
              }}
            >
              <div
                className={cn(
                  "relative h-full rounded-xl transition duration-200",
                  dragging && "scale-102 shadow-lg"
                )}
              >
                <WidgetControls
                  value={{
                    movable: true,
                    actions: (
                      <span className={atHand}>
                        <Grip
                          id={id}
                          onKeyDown={(event) => {
                            moveByKey(id, event);
                          }}
                          title={title}
                        />
                        <BlockButton
                          label={t`Take off the dashboard`}
                          onClick={() => {
                            remove(id);
                          }}
                        >
                          <XIcon />
                        </BlockButton>
                      </span>
                    ),
                  }}
                >
                  {widgetBlocks[id](board, title)}
                </WidgetControls>
              </div>
            </div>
          );
        })}
        {/* Adding is on the board, always, in the place a new widget takes. */}
        <AddTile missing={missing} onAdd={add} />
      </div>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <ErrorText>{failure}</ErrorText>
      {differsFromDefault(widgets, board.offered) ? (
        <ResetLine onReset={reset} />
      ) : null}
    </div>
  );
};
