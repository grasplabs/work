import type { App } from "@grasp-os/shared/apps";
import type { StandardWidgetId } from "@grasp-os/shared/dashboard";
import type { RunActivity, WorkflowSummary } from "@grasp-os/shared/workflows";
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
import { useRef, useState } from "react";
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
  defaultWidgets,
  differsFromDefault,
  missingWidgets,
  moveWidget,
  placeWidget,
  removeWidget,
  slotAt,
} from "./layout.ts";
import type { GridShape } from "./layout.ts";
import { RunsWidget } from "./runs-widget.tsx";
import { CouldBeBetter } from "./signals.tsx";
import type { Signals } from "./signals.tsx";
import { WidgetBlock, WidgetControls, WidgetLoading } from "./widget-block.tsx";

// The dashboard's widget board, under what waits on the person, as the
// prototype lays it out (`components/dashboard/widget-board.tsx`,
// `widget-add.tsx`): blocks of one size, one column, two side by side
// where the board is wide enough. Each opens in full. Each person has
// their own board: the widgets on it in their order (where the workflows
// stand, each engine's workflows, the runs this week, and what could be
// better, to begin with), saved in core whole with each change. There is
// no mode for changing it: a block pointed at shows its grip, to drag it
// (or by its title, with the mouse) or move it with the arrow keys, and
// the button that takes it off; the last place is an empty card that adds
// one back; and a quiet line under the board puts it back as it began.
// Each comes as it is read, so a slow one holds back no other. The
// prototype's widgets Grasp makes, and the hours and euros its widgets
// count, aren't here: core keeps none of it.

/** The engines the person can open, with the workflows. */
export interface EnginesRead {
  apps: App[];
  workflows: WorkflowSummary[];
}

/** What the board reads, each on its own, and the person's order of it. */
export interface Board {
  /** The widgets on the person's board, in order. */
  layout: readonly StandardWidgetId[];
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

/** How many engines there are with no workflow to show, if any. */
const Others = ({ count }: { count: number }) =>
  count === 0 ? null : (
    <p className="text-muted-foreground border-t pt-3 text-xs first:border-t-0 first:pt-0">
      <Plural
        one="# more engine with no workflows to show"
        other="# more engines with no workflows to show"
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
              to="/engines/$engine"
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
  const { engines, others } = enginesOf(apps, rows);
  return (
    <WidgetBlock
      count={engines.length}
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
      <Others count={others} />
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

/** Each widget's name: its block's title, and how the add card lists it. */
const widgetTitles: Record<StandardWidgetId, MessageDescriptor> = {
  workflows: msg`Workflows`,
  engines: msg`Engines`,
  runs: msg`Runs this week`,
  signals: msg`Could be better`,
};

/** Each widget in its block, titled `title`, as its read comes. */
const widgetBlocks: Record<
  StandardWidgetId,
  (board: Board, title: string) => ReactNode
> = {
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
  fromX: number;
  fromY: number;
  moved: boolean;
  before: readonly StandardWidgetId[];
  order: readonly StandardWidgetId[];
}

/**
 * Where a widget is moved by: a grip to drag it by (with a finger, the
 * only place to take hold of it), and the arrow keys, one place with left
 * and right, a row with up and down.
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
            aria-label={t`Move ${title}`}
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
      <TooltipContent>
        <Trans>Drag to move, or use the arrow keys</Trans>
      </TooltipContent>
    </Tooltip>
  );
};

/** The button that takes a widget off the board. */
const RemoveButton = ({
  title,
  onRemove,
}: {
  title: string;
  onRemove: () => void;
}) => {
  const { t } = useLingui();
  const label = t`Remove ${title}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            onClick={onRemove}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <XIcon />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
};

/**
 * Where a widget is added: the last place on the board, an empty card as
 * large as a block with a plus in it. Pressed, it lists the widgets not on
 * the board, each going last. Not there while every one is on it.
 */
const AddCard = ({
  missing,
  onAdd,
}: {
  missing: readonly StandardWidgetId[];
  onAdd: (id: StandardWidgetId) => void;
}) => {
  const { t, i18n } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <button
            aria-label={t`Add a widget`}
            className="border-input text-muted-foreground hover:border-ring hover:text-foreground focus-visible:ring-ring flex h-80 min-w-0 items-center justify-center rounded-xl border border-dashed transition-colors outline-none focus-visible:ring-2"
            type="button"
          />
        }
      >
        <PlusIcon aria-hidden="true" className="size-5" />
      </PopoverTrigger>
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
  );
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
  /** Saves started, so only the latest one's refusal puts the board back. */
  const saves = useRef(0);
  const titleOf = (id: StandardWidgetId) => i18n._(widgetTitles[id]);

  const save = async (
    next: readonly StandardWidgetId[],
    before: readonly StandardWidgetId[],
    said: string
  ) => {
    setWidgets(next);
    setFailure(undefined);
    setAnnouncement(said);
    saves.current += 1;
    const started = saves.current;
    await run(
      async (session) => {
        await session.dashboard.saveLayout({ widgets: [...next] });
      },
      (reason) => {
        if (saves.current === started) {
          setWidgets(before);
        }
        setFailure(reason);
      }
    );
  };

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
      void save(next, widgets, placeSaid(id, next));
    });
    grip.focus();
  };

  const remove = (id: StandardWidgetId) => {
    const title = titleOf(id);
    void save(
      removeWidget(widgets, id),
      widgets,
      t`${title} removed from the dashboard.`
    );
  };

  const add = (id: StandardWidgetId) => {
    const title = titleOf(id);
    void save(
      addWidget(widgets, id),
      widgets,
      t`${title} added to the dashboard.`
    );
  };

  const reset = () => {
    void save(
      defaultWidgets,
      widgets,
      t`The dashboard is back to how it began.`
    );
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
    press.current = {
      id,
      fromX: event.clientX,
      fromY: event.clientY,
      moved: false,
      before: widgets,
      order: widgets,
    };
    const follow = (moved: globalThis.PointerEvent) => {
      const held = press.current;
      if (held === null) {
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
    const drop = () => {
      window.removeEventListener("pointermove", follow);
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", drop);
      const held = press.current;
      press.current = null;
      setDragged(null);
      if (held !== null && held.moved && held.order !== held.before) {
        void save(held.order, held.before, placeSaid(held.id, held.order));
      }
    };
    window.addEventListener("pointermove", follow);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", drop);
  };

  const missing = missingWidgets(widgets);
  return (
    <div className="@container flex flex-col gap-3">
      <div
        className={cn(
          "grid grid-cols-1 gap-4 @4xl:grid-cols-2",
          dragged !== null && "cursor-grabbing select-none"
        )}
        ref={grid}
      >
        {widgets.map((id) => {
          const title = titleOf(id);
          return (
            <div
              className={cn(
                "group/block min-w-0 rounded-xl",
                dragged === id && "ring-ring opacity-80 shadow-lg ring-2"
              )}
              data-widget={id}
              key={id}
              onPointerDown={(event) => {
                startDrag(id, event);
              }}
            >
              <WidgetControls
                value={
                  <span className={atHand}>
                    <Grip
                      id={id}
                      onKeyDown={(event) => {
                        moveByKey(id, event);
                      }}
                      title={title}
                    />
                    <RemoveButton
                      onRemove={() => {
                        remove(id);
                      }}
                      title={title}
                    />
                  </span>
                }
              >
                {widgetBlocks[id](board, title)}
              </WidgetControls>
            </div>
          );
        })}
        {missing.length === 0 ? null : (
          <AddCard missing={missing} onAdd={add} />
        )}
      </div>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <ErrorText>{failure}</ErrorText>
      {differsFromDefault(widgets) ? (
        <div className="flex justify-center">
          <Button onClick={reset} size="xs" variant="link">
            <Trans>Back to how it began</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
};
