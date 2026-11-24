import type {
  DiagramNext,
  DiagramScope,
  DiagramTask,
  TraceState,
  WorkflowDiagram,
} from "@grasp-os/shared/workflow-diagrams";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import { Icon, PencilIcon } from "@grasp-os/ui/lib/icons";
import {
  colors,
  duration,
  font,
  radius,
  shadow,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

// A workflow's diagram as core drew it from a definition that passed the
// profile: every task in order, by its ID, with every case, branch and
// list it declares, and where each goes next. The page draws nothing of
// its own: no task, branch or path that isn't in the diagram core sent.
// A run's trace, when given, marks the tasks that run's journal reached.
// Showing it runs nothing. Steps are named by their titles, so the
// drawing has no parts of its own. On the Flow canvas (`workflow-flow.tsx`) the same drawing reads left to right or top
// to bottom, its own tasks cards joined by dotted lines, and a builder
// opens one of them to change it (`onStep`). Its marks, buttons and empty
// state are Damsko's; its cards, lines and lists are laid out here.

const styles = stylex.create({
  line: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
  },
  muted: { color: colors.mutedForeground },
  name: { fontWeight: font.weightMedium },
  // An ID or a literal from the definition: the quiet mono look, so it reads as an ID.
  code: {
    fontFamily: font.mono,
    fontSize: font.textXs,
    color: colors.mutedForeground,
  },
  // The dotted line between two cards, in the page's quiet ink.
  wire: {
    flexShrink: 0,
    borderStyle: "dotted",
    borderWidth: 0,
    borderColor: colors.subtleForeground,
  },
  wireSide: { width: space["10"], borderBlockStartWidth: "2px" },
  wireStacked: { height: space["8"], borderInlineStartWidth: "2px" },
  list: { display: "flex" },
  listNested: { flexDirection: "column", gap: space["2"] },
  listSide: { flexDirection: "row", alignItems: "center" },
  listStacked: { flexDirection: "column", alignItems: "center" },
  itemSide: { display: "flex", flexShrink: 0, alignItems: "center" },
  itemStacked: {
    display: "flex",
    flexShrink: 0,
    flexDirection: "column",
    alignItems: "center",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    padding: space["3"],
    backgroundColor: colors.card,
    borderRadius: radius.base,
    cornerShape: radius.shape,
    transitionProperty: "box-shadow",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // On the canvas a card is a sheet lifted off the dotted ground; in a list, an edge.
  cardCanvas: { boxShadow: shadow.sm },
  cardFlat: { boxShadow: size.borderStrong },
  cardRow: { width: "20rem" },
  scopes: {
    display: "flex",
    flexDirection: "column",
    gap: space["3"],
    paddingInlineStart: space["3"],
    borderInlineStartWidth: size.hairline,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: colors.border,
  },
  scope: { display: "flex", flexDirection: "column", gap: space["2"] },
  drawing: { display: "flex", width: "max-content", alignItems: "center" },
  drawingSide: { flexDirection: "row" },
  drawingStacked: { flexDirection: "column" },
  view: { display: "flex", flexDirection: "column", gap: space["2"] },
});

/** Where a task or case goes once done, in words; nothing for "next". */
const NextText = ({ next }: { next: DiagramNext | null }) => {
  const { t } = useLingui();
  if (next === null || next.kind === "continue") {
    return null;
  }
  if (next.kind === "end") {
    return <Badge size="sm">{t`Ends the workflow`}</Badge>;
  }
  if (next.kind === "exit") {
    return <Badge size="sm">{t`Leaves this list`}</Badge>;
  }
  const { task } = next;
  return <Badge size="sm">{t`Then ${task}`}</Badge>;
};

/** How a run's journal left a task, in words. */
const StateBadge = ({ state }: { state: TraceState | undefined }) => {
  const { t } = useLingui();
  if (state === undefined) {
    return null;
  }
  const label = {
    reached: t({ message: "Done", context: "a step of a run that is done" }),
    running: t({ message: "Running", context: "an attempt of a step" }),
    waiting: t`Waiting`,
    failed: t`Failed`,
  }[state];
  return (
    <Badge size="sm" variant={state === "failed" ? "warning" : "default"}>
      {label}
    </Badge>
  );
};

/** What a scope is, in words: an `if`'s branches, a `try` and its catch, a loop's steps. */
const ScopeHeading = ({ scope }: { scope: DiagramScope }) => {
  const { t } = useLingui();
  const headings = new Map<DiagramScope["kind"], string>([
    ["then", t`When it holds`],
    ["else", t`Otherwise`],
    ["try", t`Try`],
    ["catch", t`If it fails`],
    ["each", t`For each item`],
  ]);
  const heading = headings.get(scope.kind);
  return (
    <div {...stylex.props(styles.line)}>
      <span {...stylex.props(styles.muted)}>{heading}</span>
      <NextText next={scope.next} />
    </div>
  );
};

/** What a run's journal says of its tasks, by ID. */
interface Marks {
  states: ReadonlyMap<string, TraceState>;
  /** How many attempts each made; a task with one shows none. */
  attempts: ReadonlyMap<string, number>;
  /** Drawn on the canvas: cards that lift off its dotted ground. */
  canvas: boolean;
  /** Opens a task to change it, where its builder may. */
  onStep: ((task: DiagramTask) => void) | undefined;
}

/** How the drawing reads: one under the other, or side by side. */
export type Layout = "stacked" | "side";

/** The dotted line between two cards on the canvas, as the drawing reads. */
const Wire = ({ layout }: { layout: Layout }) => (
  <span
    aria-hidden="true"
    {...stylex.props(
      styles.wire,
      layout === "side" ? styles.wireSide : styles.wireStacked
    )}
  />
);

/**
 * Tasks in order, one under the other; or, for the workflow's own tasks on
 * the canvas (`row`), cards joined by dotted lines the way it reads.
 */
const TaskList = ({
  tasks,
  marks,
  row,
}: {
  tasks: readonly DiagramTask[];
  marks: Marks;
  /** How the canvas reads its own tasks; none for tasks in a task. */
  row?: Layout;
}) => (
  <ol
    {...stylex.props(
      styles.list,
      row === undefined && styles.listNested,
      row === "side" && styles.listSide,
      row === "stacked" && styles.listStacked
    )}
  >
    {tasks.map((task) => (
      // eslint-disable-next-line no-use-before-define -- tasks nest in tasks
      <TaskItem key={task.pointer} marks={marks} row={row} task={task} />
    ))}
  </ol>
);

/**
 * Its name: its title where the definition gives one, else its ID in the
 * quiet mono look, so an ID reads as one; a button that opens it to change
 * it, where it may be changed.
 */
const TaskId = ({ task, marks }: { task: DiagramTask; marks: Marks }) => {
  const { t } = useLingui();
  const { onStep } = marks;
  const { id, label } = task;
  const shown =
    label === null ? (
      <code {...stylex.props(styles.code)}>{id}</code>
    ) : (
      <span {...stylex.props(styles.name)}>{label}</span>
    );
  if (onStep === undefined) {
    return shown;
  }
  return (
    <Button
      aria-label={t`Change step ${id}`}
      onClick={() => {
        onStep(task);
      }}
      size="xs"
      variant="ghost"
    >
      {shown}
      <Icon icon={PencilIcon} />
    </Button>
  );
};

const TaskItem = ({
  task,
  marks,
  row,
}: {
  task: DiagramTask;
  marks: Marks;
  row: Layout | undefined;
}) => {
  const { t } = useLingui();
  const state = marks.states.get(task.id);
  const attempts = marks.attempts.get(task.id) ?? 0;
  return (
    <li
      aria-label={task.id}
      {...stylex.props(
        row === "side" && styles.itemSide,
        row === "stacked" && styles.itemStacked
      )}
      data-pointer={task.pointer}
      data-state={state ?? "none"}
    >
      {row === undefined ? null : <Wire layout={row} />}
      <div
        {...stylex.props(
          styles.card,
          marks.canvas ? styles.cardCanvas : styles.cardFlat,
          row !== undefined && styles.cardRow
        )}
      >
        <div {...stylex.props(styles.line)}>
          <TaskId marks={marks} task={task} />
          <Badge size="sm">{task.kind}</Badge>
          {task.detail === null ? null : (
            <code {...stylex.props(styles.code)}>{task.detail}</code>
          )}
          {task.guarded ? (
            <Badge size="sm">{t`Only if its condition holds`}</Badge>
          ) : null}
          <NextText next={task.next} />
          <StateBadge state={state} />
          {attempts > 1 ? (
            <Badge size="sm">
              {t`${plural(attempts, { one: "# attempt", other: "# attempts" })}`}
            </Badge>
          ) : null}
        </div>
        {task.scopes.length === 0 ? null : (
          <div {...stylex.props(styles.scopes)}>
            {task.scopes.map((scope) => (
              <div
                {...stylex.props(styles.scope)}
                key={`${scope.kind} ${scope.name ?? ""}`}
              >
                <ScopeHeading scope={scope} />
                {scope.tasks.length === 0 ? null : (
                  <TaskList marks={marks} tasks={scope.tasks} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </li>
  );
};

/** No run shown: no task marked. */
const noStates: ReadonlyMap<string, TraceState> = new Map();
const noAttempts: ReadonlyMap<string, number> = new Map();

/** What the canvas sets of the drawing: how it reads, and what it adds. */
interface CanvasOptions {
  layout: Layout;
  /** Before the workflow's first task: where it starts. */
  start: ReactNode;
  /** After its last: where it ends. */
  end: ReactNode;
  /** Opens a task to change it; none where it may not be changed. */
  onStep: ((task: DiagramTask) => void) | undefined;
}

/**
 * The drawing on the canvas: where it starts, its tasks as cards that
 * read as `layout` says, and where it ends, joined by dotted lines.
 */
const CanvasDrawing = ({
  diagram,
  marks,
  canvas,
}: {
  diagram: WorkflowDiagram;
  marks: Marks;
  canvas: CanvasOptions;
}) => {
  const { layout } = canvas;
  return (
    <div
      {...stylex.props(
        styles.drawing,
        layout === "side" ? styles.drawingSide : styles.drawingStacked
      )}
    >
      {canvas.start}
      <TaskList marks={marks} row={layout} tasks={diagram.tasks} />
      <Wire layout={layout} />
      {canvas.end}
    </div>
  );
};

/**
 * `diagram`, with the tasks a run reached marked as `states` says, and
 * the attempts each made: none when no run is shown. On the canvas
 * (`canvas`), as the canvas lays it out.
 */
export const WorkflowDiagramView = ({
  diagram,
  states = noStates,
  attempts = noAttempts,
  label,
  canvas,
}: {
  diagram: WorkflowDiagram;
  states?: ReadonlyMap<string, TraceState>;
  attempts?: ReadonlyMap<string, number>;
  label: string;
  canvas?: CanvasOptions;
}) => {
  const { t } = useLingui();
  const marks: Marks = {
    states,
    attempts,
    canvas: canvas !== undefined,
    onStep: canvas?.onStep,
  };
  return (
    <section aria-label={label} {...stylex.props(styles.view)}>
      {diagram.tasks.length === 0 ? (
        <Empty size="sm">
          <EmptyHeader>
            <EmptyDescription>
              {t`No steps to draw: it works out its result in one go.`}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {diagram.tasks.length > 0 && canvas !== undefined ? (
        <CanvasDrawing canvas={canvas} diagram={diagram} marks={marks} />
      ) : null}
      {diagram.tasks.length > 0 && canvas === undefined ? (
        <TaskList marks={marks} tasks={diagram.tasks} />
      ) : null}
    </section>
  );
};
