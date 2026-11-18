import type { App } from "@grasp-os/shared/apps";
import { standardWidgetIdSchema } from "@grasp-os/shared/dashboard";
import type {
  DashboardWidgetId,
  StandardWidgetId,
} from "@grasp-os/shared/dashboard";
import type { ModelMonthSpend } from "@grasp-os/shared/models";
import type { CustomWidget, WidgetProgress } from "@grasp-os/shared/widgets";
import type { RunActivity, WorkflowSummary } from "@grasp-os/shared/workflows";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Await, Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { flushSync } from "react-dom";

import { ErrorText } from "../error-text.tsx";
import { formatDate } from "../format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../grasp/alert-dialog/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import type { BadgeTone } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Card } from "../grasp/card/index.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
} from "../grasp/empty/index.ts";
import { focus } from "../grasp/focus/focus.ts";
import { visuallyHidden } from "../grasp/hidden/hidden.ts";
import { Cross, Plus } from "../grasp/icons/index.ts";
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "../grasp/item/index.ts";
import { Link as TextLink } from "../grasp/link/index.ts";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "../grasp/popover/index.ts";
import { Separator } from "../grasp/separator/index.ts";
import { Stat } from "../grasp/stats/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { byState, stateOf, workflowStates } from "./board.ts";
import type { WorkflowState } from "./board.ts";
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
import { MakingDots } from "./making-dots.tsx";
import type { GoalProgress, WorkReturns } from "./returns.ts";
import { RunsWidget } from "./runs-widget.tsx";
import { CouldBeBetter } from "./signals.tsx";
import type { Signals } from "./signals.tsx";
import { SpendWidget } from "./spend-widget.tsx";
import { GoalListView, ReturnChartView } from "./standard-widgets.tsx";
import { ChangeWidget, WidgetAsk } from "./widget-ask.tsx";
import {
  BlockButton,
  WidgetBlock,
  WidgetControls,
  WidgetLoading,
  useFull,
} from "./widget-block.tsx";
import { WidgetProgressLine } from "./widget-progress.tsx";

// A widget Grasp made draws its charts with Recharts, which loads only on a
// board that has one.
const CustomWidgetBlock = lazy(async () => {
  const { CustomWidgetBlock: block } = await import("./custom-widget.tsx");
  return { default: block };
});

// The dashboard's widget board, under what waits on the person, as the
// prototype's (`components/dashboard/widget-board.tsx`, `widget-add.tsx`,
// `widget-parts.tsx`): blocks of one size, one column, two side by side
// where the board is wide enough. Each opens in full. Each person has
// their own board: the widgets on it in their order, saved in core whole
// with each change. It begins with the prototype's four (what the work
// returns a month, the board's goals, how far each team is with AI,
// where the workflows stand), then the Apps, the runs this week and what
// could be better. There is no mode for changing it: a
// block pointed at shows its grip, to drag it (or by its title, with the
// mouse) or move it with the arrow keys, and the button that takes it
// off; the last place is an empty card that adds one; and a quiet line
// under the board puts it back as it began. Each comes as it is read, so
// a slow one holds back no other.
//
// Grasp makes a widget from what someone asks, from the empty card
// (custom-widget.tsx draws it): core has the model write it, checks it
// against what the person may see, and keeps it on their board. A widget
// Grasp made is changed from its block's sparkle (`changeWidget`,
// widget-ask.tsx), and while Grasp makes or changes one, its place is
// drawn in dots (making-dots.tsx). What the prototype's board has
// besides: the blocks gliding out of each other's way. The goals widget
// reads the board's goals from core, each with the workflows linked to
// it; the return and teams widgets count what core doesn't keep yet: they
// show what the prototype shows with nothing to count (`returns.ts`).

/** What the board reads, each on its own, and the person's order of it. */
export interface Board {
  /** The widgets on the person's board, in order. */
  layout: readonly DashboardWidgetId[];
  /** The widgets Grasp offers them, as their board begins (`offeredWidgets`). */
  offered: readonly StandardWidgetId[];
  /** The widgets Grasp made for them from what they asked, as core read them. */
  made: Loaded<CustomWidget[]>;
  /** What the return widget counts. */
  returns: WorkReturns;
  /** The board's goals, and how far the workflows that serve each are. */
  goals: Promise<Loaded<GoalProgress[]>>;
  workflows: Promise<Loaded<WorkflowSummary[]>>;
  /** The Apps the person can open. */
  apps: Promise<Loaded<App[]>>;
  runs: Promise<Loaded<RunActivity>>;
  signals: Promise<Loaded<Signals>>;
  /** What the models cost this month: admins only, the only ones offered its widget. */
  spend: Promise<Loaded<ModelMonthSpend>> | undefined;
}

/** Each state's dot: amber where a person is needed, green once it ran, grey before. */
const stateTones: Record<WorkflowState, BadgeTone> = {
  attention: "attention",
  waiting: "attention",
  ran: "success",
  notRun: "neutral",
};

/** Each state's name. */
const stateNames: Record<WorkflowState, MessageDescriptor> = {
  attention: msg`Needs attention`,
  waiting: msg`Waiting on a person`,
  ran: msg`Ran`,
  notRun: msg`Not run yet`,
};

/** How tall a block on the board is, every one alike. */
const BLOCK_HEIGHT = "20rem";
/** Where the board is wide enough for two blocks side by side. */
const TWO_UP = "@container (width >= 56rem)";
/** Where a state's name stands beside its workflows, in full. */
const SIDE_BY_SIDE = "@container (width >= 32rem)";
/** Where there is room for when each workflow last ran, in full. */
const ROOM_FOR_DATES = "@container (width >= 28rem)";
/** A block dragged stands over the others (and over the dots, at 10). */
const ABOVE = 30;
/** How much a dragged block is lifted. */
const LIFTED = "scale(1.02)";

const HOVER = media.hover;
const COARSE = media.coarse;
const REDUCED = media.reduced;

const styles = stylex.create({
  // A workflow's dot, the target that opens it.
  dot: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: grasp.space4,
    height: grasp.space4,
    borderRadius: grasp.cornerCircle,
  },
  columns: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    columnGap: grasp.space2,
    height: "100%",
    margin: 0,
    padding: 0,
    paddingBlockStart: grasp.space2,
    listStyle: "none",
  },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space3,
    minWidth: 0,
  },
  dots: {
    display: "flex",
    flexDirection: "column-reverse",
    alignItems: "flex-start",
    gap: grasp.space1,
    flexGrow: 1,
    minHeight: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  plainItem: { display: "flex" },
  count: { display: "flex", flexDirection: "column", gap: grasp.space2 },
  stages: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space4,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  stage: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [SIDE_BY_SIDE]: "11rem minmax(0, 1fr)",
    },
    columnGap: grasp.space6,
    rowGap: grasp.space2,
  },
  stageName: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    alignSelf: "start",
  },
  stageRows: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    minWidth: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  stageRow: {
    display: "flex",
    alignItems: "baseline",
    gap: grasp.space4,
  },
  stageLink: { flexGrow: 1, minWidth: 0 },
  date: { display: { default: "none", [ROOM_FOR_DATES]: "block" } },
  board: { containerType: "inline-size" },
  grid: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [TWO_UP]: "repeat(2, minmax(0, 1fr))",
    },
    gap: grasp.space4,
  },
  cell: { position: "relative", height: BLOCK_HEIGHT, minWidth: 0 },
  dragged: { zIndex: ABOVE, cursor: "grabbing", userSelect: "none" },
  lift: {
    position: "relative",
    height: "100%",
    borderRadius: grasp.corner,
    transitionProperty: "transform, box-shadow",
    transitionDuration: { default: grasp.durationUi, [REDUCED]: "0s" },
    transitionTimingFunction: grasp.ease,
  },
  lifted: { transform: LIFTED, boxShadow: grasp.liftHigh },
  // A block's own buttons, until it is pointed at: there, but unseen.
  // Seen with the keys in the block, and always where there is no pointer
  // to point with.
  atHand: {
    display: "flex",
    opacity: {
      default: 0,
      [stylex.when.ancestor(":is([data-widget]:hover)")]: {
        default: 0,
        [HOVER]: 1,
      },
      [stylex.when.ancestor(":is([data-widget]:focus-within)")]: 1,
      [COARSE]: 1,
    },
    transitionProperty: "opacity",
    transitionDuration: { default: grasp.durationHover, [REDUCED]: "0s" },
    transitionTimingFunction: grasp.ease,
  },
  addSpot: { position: "relative", height: BLOCK_HEIGHT, minWidth: 0 },
  addBusy: { position: "relative", height: "100%" },
  addMiddle: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
  },
  back: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    paddingBlockStart: grasp.space3,
  },
  backList: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  wide: { width: "100%" },
  reset: {
    display: "flex",
    justifyContent: "center",
    paddingBlockStart: grasp.space3,
  },
});

/** A workflow's dot that opens it, and names it when pointed at. */
const WorkflowDot = ({ workflow }: { workflow: WorkflowSummary }) => {
  const { name } = workflow;
  return (
    <Link
      aria-label={name}
      params={{ workflow: workflow.workflowId }}
      title={name}
      to="/workflows/$workflow"
      {...stylex.props(styles.dot, focus.mark)}
    >
      <Badge tone={stateTones[stateOf(workflow)]} variant="dot" />
    </Link>
  );
};

/** What a widget says when it has nothing to show, with the way to chat, where things are made. */
const NothingYet = ({ children }: { children: ReactNode }) => (
  <Empty size="section">
    <EmptyHeader>
      <EmptyDescription>{children}</EmptyDescription>
    </EmptyHeader>
    <EmptyContent>
      <Button render={<Link search={{}} to="/" />} size="sm">
        <Trans>Open Chat</Trans>
      </Button>
    </EmptyContent>
  </Empty>
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
 * each with when it last ran. The prototype's columns are
 * the five steps on the way to live, which core doesn't keep.
 */
const WorkflowTabsView = ({ rows }: { rows: readonly WorkflowSummary[] }) => {
  const { i18n } = useLingui();
  const full = useFull();
  const states = byState(rows);
  if (!full) {
    return (
      <ol {...stylex.props(styles.columns)}>
        {workflowStates.map((state) => {
          const here = states[state];
          const name = i18n._(stateNames[state]);
          return (
            <li key={state} {...stylex.props(styles.column)}>
              <ul aria-label={name} {...stylex.props(styles.dots)}>
                {here.map((workflow) => (
                  <li
                    key={workflow.workflowId}
                    {...stylex.props(styles.plainItem)}
                  >
                    <WorkflowDot workflow={workflow} />
                  </li>
                ))}
              </ul>
              <span {...stylex.props(styles.count)}>
                <Separator decorative />
                <Stat bare title={name} value={String(here.length)} />
              </span>
            </li>
          );
        })}
      </ol>
    );
  }
  const shown = workflowStates.filter((state) => states[state].length > 0);
  return (
    <ol {...stylex.props(styles.stages)}>
      {shown.map((state, index) => {
        const here = states[state];
        const name = i18n._(stateNames[state]);
        return (
          <li key={state} {...stylex.props(styles.count)}>
            {index === 0 ? null : <Separator decorative />}
            <span {...stylex.props(styles.stage)}>
              <span {...stylex.props(styles.stageName)}>
                <Badge tone={stateTones[state]} variant="dot">
                  {name}
                </Badge>
                <Text element="span" size="sm" tone="muted">
                  {here.length}
                </Text>
              </span>
              <ul aria-label={name} {...stylex.props(styles.stageRows)}>
                {here.map((workflow) => (
                  <li
                    key={workflow.workflowId}
                    {...stylex.props(styles.stageRow)}
                  >
                    <TextLink
                      layout={styles.stageLink}
                      render={
                        <Link
                          params={{ workflow: workflow.workflowId }}
                          to="/workflows/$workflow"
                        />
                      }
                    >
                      {workflow.name}
                    </TextLink>
                    <Text
                      element="span"
                      layout={styles.date}
                      size="sm"
                      tone="muted"
                    >
                      <LastRun workflow={workflow} />
                    </Text>
                  </li>
                ))}
              </ul>
            </span>
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

/** Each App the person can open, opening it. */
const AppsWidget = ({ apps }: { apps: App[] }) => {
  const { t } = useLingui();
  const title = t`Apps`;
  if (apps.length === 0) {
    return (
      <WidgetBlock title={title}>
        <NothingYet>
          <Trans>No Apps yet. Apps are made in chat.</Trans>
        </NothingYet>
      </WidgetBlock>
    );
  }
  return (
    <WidgetBlock title={title}>
      <ItemGroup aria-label={title} separated>
        {apps.map((app) => (
          <Item
            key={app.id}
            render={<Link params={{ app: app.id }} to="/apps/$app" />}
            size="xs"
          >
            <ItemContent>
              <ItemTitle>{app.name}</ItemTitle>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
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
  workflows: msg`Workflows`,
  apps: msg`Apps`,
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
  goals: (board, title) => (
    <Await fallback={<WidgetLoading title={title} />} promise={board.goals}>
      {(loaded) =>
        loaded.state === "ready" ? (
          <WidgetBlock
            full={<GoalListView goals={loaded.data} />}
            title={title}
          >
            <GoalListView goals={loaded.data} />
          </WidgetBlock>
        ) : (
          <NotRead loaded={loaded} title={title} />
        )
      }
    </Await>
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
  apps: (board, title) => (
    <Await fallback={<WidgetLoading title={title} />} promise={board.apps}>
      {(loaded) =>
        loaded.state === "ready" ? (
          <AppsWidget apps={loaded.data} />
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
 * A widget on the board in its block: one of Grasp's own, or one Grasp
 * made for the person (`made`); one core couldn't read says so.
 */
const BoardWidget = ({
  board,
  id,
  made,
  title,
}: {
  board: Board;
  id: DashboardWidgetId;
  made: ReadonlyMap<string, CustomWidget>;
  title: string;
}) => {
  const standard = standardWidgetIdSchema.safeParse(id);
  if (standard.success) {
    return <>{widgetBlocks[standard.data](board, title)}</>;
  }
  const widget = made.get(id);
  if (widget !== undefined) {
    return (
      <Suspense fallback={<WidgetLoading title={widget.view.title} />}>
        <CustomWidgetBlock widget={widget} />
      </Suspense>
    );
  }
  return board.made.state === "ready" ? null : (
    <NotRead loaded={board.made} title={title} />
  );
};

/** The Section card's title row, by which a block is taken. */
const handleSlot = '[data-slot="section-card-handle"]';

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
  id: DashboardWidgetId;
  /** The pointer that took hold of it: another one, a second finger, is ignored. */
  pointer: number;
  fromX: number;
  fromY: number;
  moved: boolean;
  before: readonly DashboardWidgetId[];
  order: readonly DashboardWidgetId[];
}

/**
 * Where a widget is added, as the prototype's (`widget-add.tsx`): the last
 * place on the board, always there, an empty card as large as a block with
 * nothing in it but a plus. A press asks what the widget should show, and
 * Grasp makes it through core (`makeWidget`), which puts it last on the
 * board; under that, the widgets taken off the board, Grasp's own and
 * those Grasp made, each going back last.
 */
const AddTile = ({
  missing,
  takenOff,
  titleOf,
  onAdd,
  onMade,
}: {
  missing: readonly StandardWidgetId[];
  takenOff: readonly CustomWidget[];
  titleOf: (id: DashboardWidgetId) => string;
  onAdd: (id: DashboardWidgetId) => void;
  onMade: (widget: CustomWidget) => void;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  // Drawn in dots while Grasp makes the widget, in the place it takes,
  // with how it goes.
  const [making, setMaking] = useState(false);
  const [progress, setProgress] = useState<WidgetProgress | null>(null);
  const back: readonly DashboardWidgetId[] = [
    ...missing,
    ...takenOff.map(({ id }) => id),
  ];
  return (
    <div {...stylex.props(styles.addSpot)}>
      <div aria-busy={making} {...stylex.props(styles.addBusy)}>
        {making ? (
          <>
            <MakingDots />
            <WidgetProgressLine progress={progress} />
          </>
        ) : null}
        <Card fill padding="none" variant="soft">
          <div {...stylex.props(styles.addMiddle)}>
            <Popover onOpenChange={setOpen} open={open}>
              <PopoverTrigger
                aria-label={t`Add a widget`}
                icon={Plus}
                size="lg"
                variant="ghost"
              />
              <PopoverContent>
                <PopoverTitle>
                  <Trans>Add a widget</Trans>
                </PopoverTitle>
                <WidgetAsk
                  ask={async (session, asked, told) =>
                    await session.dashboard.makeWidget(asked, told)
                  }
                  label={t`Ask Grasp for a widget`}
                  onBusy={setMaking}
                  onDone={() => {
                    setOpen(false);
                  }}
                  onMade={onMade}
                  onProgress={setProgress}
                  placeholder={t`Which workflows failed most this month?`}
                />
                {back.length === 0 ? null : (
                  <>
                    <Separator decorative />
                    <div {...stylex.props(styles.back)}>
                      <Text size="xs" tone="muted">
                        <Trans>Put one back</Trans>
                      </Text>
                      <ul {...stylex.props(styles.backList)}>
                        {back.map((id) => (
                          <li key={id}>
                            <Button
                              layout={styles.wide}
                              onClick={() => {
                                setOpen(false);
                                onAdd(id);
                              }}
                              variant="ghost"
                            >
                              {titleOf(id)}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </>
                )}
              </PopoverContent>
            </Popover>
          </div>
        </Card>
      </div>
    </div>
  );
};

/**
 * Putting the board back as it began: one quiet line under it, only when
 * it is not as it began.
 */
const ResetLine = ({ onReset }: { onReset: () => void }) => (
  <div {...stylex.props(styles.reset)}>
    <Button onClick={onReset} size="xs" variant="ghost">
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
  // The widget Grasp is changing now, drawn in dots meanwhile.
  const [changing, setChanging] = useState<DashboardWidgetId | null>(null);
  const [changeProgress, setChangeProgress] = useState<WidgetProgress | null>(
    null
  );
  const [dragged, setDragged] = useState<DashboardWidgetId | null>(null);
  // The widget Grasp made that is asked about before it goes for good.
  const [asking, setAsking] = useState<DashboardWidgetId | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const press = useRef<Press | null>(null);
  /** Ends the drag under way, if any, without saving it. */
  const stopDrag = useRef<(() => void) | null>(null);
  /** The layout core last took: what a refused save goes back to. */
  const confirmed = useRef(board.layout);
  /** The widgets Grasp made for them, as core last gave each. */
  const [made, setMade] = useState<ReadonlyMap<string, CustomWidget>>(
    () =>
      new Map(
        board.made.state === "ready"
          ? board.made.data.map((widget) => [widget.id, widget])
          : []
      )
  );
  const titleOf = (id: DashboardWidgetId) => {
    const standard = standardWidgetIdSchema.safeParse(id);
    return standard.success
      ? i18n._(widgetTitles[standard.data])
      : (made.get(id)?.view.title ?? t`A widget Grasp made`);
  };

  // A save that core refuses, with no later one to come, puts the board
  // back to what core last took: never to a layout only this page had.
  const save = async (next: readonly DashboardWidgetId[], said: string) => {
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
    id: DashboardWidgetId,
    order: readonly DashboardWidgetId[]
  ) => {
    const title = titleOf(id);
    const place = order.indexOf(id) + 1;
    const count = order.length;
    return t`${title} is now in place ${place} of ${count}.`;
  };

  const moveByKey = (
    id: DashboardWidgetId,
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

  const remove = (id: DashboardWidgetId) => {
    const title = titleOf(id);
    const said = t`${title} removed from the dashboard.`;
    if (standardWidgetIdSchema.safeParse(id).success || !made.has(id)) {
      void save(removeWidget(widgets, id), said);
      return;
    }
    // A widget Grasp made goes for good: core forgets it and takes it off
    // the board it keeps, so the board here follows.
    void (async () => {
      const gone = await run(
        async (session) => {
          await session.dashboard.removeWidget(id);
          return true;
        },
        (reason) => {
          setFailure(reason);
        }
      );
      if (gone !== true) {
        return;
      }
      setMade(new Map([...made].filter(([each]) => each !== id)));
      confirmed.current = removeWidget(confirmed.current, id);
      setWidgets(removeWidget(widgets, id));
      setAnnouncement(said);
    })();
  };

  /** A widget Grasp just made: core put it last on the board it keeps. */
  const madeOne = (widget: CustomWidget) => {
    setMade(new Map([...made, [widget.id, widget]]));
    confirmed.current = addWidget(confirmed.current, widget.id);
    setWidgets(addWidget(widgets, widget.id));
    const { title } = widget.view;
    setAnnouncement(t`${title} added to the dashboard.`);
  };

  /** A widget Grasp just changed: it keeps its place. */
  const changedOne = (widget: CustomWidget) => {
    setMade(new Map([...made, [widget.id, widget]]));
    const { title } = widget.view;
    setAnnouncement(t`${title} changed.`);
  };

  const add = (id: DashboardWidgetId) => {
    const title = titleOf(id);
    void save(addWidget(widgets, id), t`${title} added to the dashboard.`);
  };

  const reset = () => {
    void save(board.offered, t`The dashboard is back to how it began.`);
  };

  // A drag follows the pointer over the whole page, so a block that moves
  // under it while it is dragged doesn't lose it.
  const startDrag = (
    id: DashboardWidgetId,
    event: PointerEvent<HTMLElement>
  ) => {
    if (event.button !== 0 || !(event.target instanceof Element)) {
      return;
    }
    // A block is taken by its title row (the Section card's handle), never
    // by one of the buttons beside it.
    if (event.target.closest(handleSlot) === null) {
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
  const name = asking === null ? "" : titleOf(asking);
  return (
    <div {...stylex.props(styles.board)}>
      <div ref={grid} {...stylex.props(styles.grid)}>
        {widgets.map((id) => {
          const title = titleOf(id);
          const dragging = dragged === id;
          const changeable = made.get(id);
          return (
            <div
              data-widget={id}
              key={id}
              onPointerDown={(event) => {
                startDrag(id, event);
              }}
              {...stylex.props(
                stylex.defaultMarker(),
                styles.cell,
                dragging && styles.dragged
              )}
            >
              <div
                aria-busy={changing === id}
                {...stylex.props(styles.lift, dragging && styles.lifted)}
              >
                {changing === id ? (
                  <>
                    <MakingDots />
                    <WidgetProgressLine progress={changeProgress} />
                  </>
                ) : null}
                <WidgetControls
                  value={{
                    handle: {
                      label: t`Move ${title}: drag it, or use the arrow keys`,
                      onKeyDown: (event) => {
                        moveByKey(id, event);
                      },
                    },
                    actions: (
                      <span {...stylex.props(styles.atHand)}>
                        {changeable === undefined ? null : (
                          <ChangeWidget
                            onBusy={(busy) => {
                              setChanging(busy ? id : null);
                            }}
                            onChanged={changedOne}
                            onProgress={setChangeProgress}
                            widget={changeable}
                          />
                        )}
                        <BlockButton
                          icon={Cross}
                          label={t`Take off the dashboard`}
                          onClick={() => {
                            if (changeable === undefined) {
                              remove(id);
                            } else {
                              setAsking(id);
                            }
                          }}
                        />
                      </span>
                    ),
                  }}
                >
                  <BoardWidget
                    board={board}
                    id={id}
                    made={made}
                    title={title}
                  />
                </WidgetControls>
              </div>
            </div>
          );
        })}
        {/* Adding is on the board, always, in the place a new widget takes. */}
        <AddTile
          missing={missing}
          onAdd={add}
          onMade={madeOne}
          takenOff={[...made.values()].filter(
            (widget) => !widgets.includes(widget.id)
          )}
          titleOf={titleOf}
        />
      </div>
      <p aria-live="polite" {...stylex.props(visuallyHidden)}>
        {announcement}
      </p>
      <ErrorText>{failure}</ErrorText>
      {differsFromDefault(widgets, board.offered) ? (
        <ResetLine onReset={reset} />
      ) : null}
      {/* A widget Grasp made goes for good once taken off: it asks first. */}
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            setAsking(null);
          }
        }}
        open={asking !== null}
      >
        <AlertDialogContent>
          <AlertDialogTitle>{t`Delete ${name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {t`Grasp made this widget for you. Taken off, it is gone for good.`}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
            <AlertDialogAction
              onClick={() => {
                if (asking !== null) {
                  remove(asking);
                }
              }}
              variant="danger"
            >
              {t`Delete`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
