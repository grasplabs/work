import type {
  DiagramNext,
  DiagramScope,
  DiagramTask,
  TraceState,
  WorkflowDiagram,
} from "@grasp-os/shared/workflow-diagrams";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { cn } from "@grasp-os/ui/lib/utils";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { PencilIcon } from "lucide-react";
import type { ReactNode } from "react";

// A workflow's diagram as core drew it from a definition that passed the
// profile: every task in order, by its ID, with every case, branch and
// list it declares, and where each goes next. The page draws nothing of
// its own: no task, branch or path that isn't in the diagram core sent.
// A run's trace, when given, marks the tasks that run's journal reached.
// Showing it runs nothing. Steps are named by their titles, so the
// drawing has no parts of its own. On the Flow canvas (`workflow-flow.tsx`) the same drawing reads left to right or top
// to bottom, its own tasks cards joined by dotted lines, and a builder
// opens one of them to change it (`onStep`).

/** Where a task or case goes once done, in words; nothing for "next". */
const NextText = ({ next }: { next: DiagramNext | null }) => {
  const { t } = useLingui();
  if (next === null || next.kind === "continue") {
    return null;
  }
  if (next.kind === "end") {
    return <Badge variant="outline">{t`Ends the workflow`}</Badge>;
  }
  if (next.kind === "exit") {
    return <Badge variant="outline">{t`Leaves this list`}</Badge>;
  }
  const { task } = next;
  return <Badge variant="outline">{t`Then ${task}`}</Badge>;
};

/** How a run's journal left a task, in words. */
const StateBadge = ({ state }: { state: TraceState | undefined }) => {
  const { t } = useLingui();
  if (state === undefined) {
    return null;
  }
  const label = {
    reached: t`Reached`,
    running: t({ message: "Running", context: "an attempt of a step" }),
    waiting: t`Waiting`,
    failed: t`Failed`,
  }[state];
  return (
    <Badge variant={state === "failed" ? "attention" : "secondary"}>
      {label}
    </Badge>
  );
};

/** What a scope is, in words: an `if`'s branches, a `try` and its catch. */
const ScopeHeading = ({ scope }: { scope: DiagramScope }) => {
  const { t } = useLingui();
  const headings = new Map<DiagramScope["kind"], string>([
    ["then", t`When it holds`],
    ["else", t`Otherwise`],
    ["try", t`Try`],
    ["catch", t`If it fails`],
  ]);
  const heading = headings.get(scope.kind);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground">{heading}</span>
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
export const Wire = ({ layout }: { layout: Layout }) => (
  <span
    aria-hidden="true"
    className={cn(
      "border-muted-foreground/50 flex-none border-dotted",
      layout === "side" ? "w-10 border-t-2" : "h-8 border-l-2"
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
    className={cn(
      "flex",
      row === undefined && "flex-col gap-2",
      row === "side" && "flex-row items-center",
      row === "stacked" && "flex-col items-center"
    )}
  >
    {tasks.map((task) => (
      // eslint-disable-next-line no-use-before-define -- tasks nest in tasks
      <TaskItem key={task.pointer} marks={marks} row={row} task={task} />
    ))}
  </ol>
);

/** Its ID; a button that opens it to change it, where it may be changed. */
const TaskId = ({ task, marks }: { task: DiagramTask; marks: Marks }) => {
  const { t } = useLingui();
  const { onStep } = marks;
  const { id } = task;
  if (onStep === undefined) {
    return <code className="font-medium">{id}</code>;
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
      <code>{id}</code>
      <PencilIcon aria-hidden="true" data-icon="inline-end" />
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
      className={cn(
        row === "side" && "flex flex-none items-center",
        row === "stacked" && "flex flex-none flex-col items-center"
      )}
      data-pointer={task.pointer}
      data-state={state ?? "none"}
    >
      {row === undefined ? null : <Wire layout={row} />}
      <div
        className={cn(
          "bg-card flex flex-col gap-2 p-3 transition-shadow",
          marks.canvas ? "node-sheet rounded-xl" : "rounded-lg border",
          row !== undefined && "w-80"
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <TaskId marks={marks} task={task} />
          <Badge variant="outline">{task.kind}</Badge>
          {task.label === null ? null : <span>{task.label}</span>}
          {task.detail === null ? null : (
            <span className="text-muted-foreground">{task.detail}</span>
          )}
          {task.guarded ? (
            <Badge variant="outline">{t`Only if its condition holds`}</Badge>
          ) : null}
          <NextText next={task.next} />
          <StateBadge state={state} />
          {attempts > 1 ? (
            <Badge variant="outline">
              <Plural one="# attempt" other="# attempts" value={attempts} />
            </Badge>
          ) : null}
        </div>
        {task.scopes.length === 0 ? null : (
          <div className="flex flex-col gap-3 border-l pl-3">
            {task.scopes.map((scope) => (
              <div
                className="flex flex-col gap-2"
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
export interface CanvasOptions {
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
      className={cn(
        "flex w-max",
        layout === "side" ? "flex-row items-center" : "flex-col items-center"
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
  const marks: Marks = {
    states,
    attempts,
    canvas: canvas !== undefined,
    onStep: canvas?.onStep,
  };
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      {diagram.tasks.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>It declares no tasks.</Trans>
        </p>
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
