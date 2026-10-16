import type {
  DiagramNext,
  DiagramScope,
  DiagramTask,
  TraceState,
  WorkflowDiagram,
} from "@grasp-os/shared/workflow-diagrams";
import { Badge } from "@grasp-os/ui/components/badge";
import { Trans, useLingui } from "@lingui/react/macro";

// A workflow's diagram as core drew it from a definition that passed the
// profile: every task in order, by its ID, with every case, branch and
// list it declares, and where each goes next. The page draws nothing of
// its own: no task, branch or path that isn't in the diagram core sent.
// A run's trace, when given, marks the tasks that run's journal reached.
// Showing it runs nothing.

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
  return <Badge variant="outline">{t`Then ${next.task}`}</Badge>;
};

/** How a run's journal left a task, in words. */
const StateBadge = ({ state }: { state: TraceState | undefined }) => {
  const { t } = useLingui();
  if (state === undefined) {
    return null;
  }
  const label = {
    reached: t`Reached`,
    running: t`Running`,
    waiting: t`Waiting`,
    failed: t`Failed`,
  }[state];
  return (
    <Badge variant={state === "failed" ? "destructive" : "secondary"}>
      {label}
    </Badge>
  );
};

/** What a scope is, in words: a case and its condition, a branch, a loop. */
const ScopeHeading = ({ scope }: { scope: DiagramScope }) => {
  const { t } = useLingui();
  const name = scope.name ?? "";
  const heading = {
    case: scope.guarded
      ? t`Case ${name}, when it holds`
      : t`Otherwise: ${name}`,
    branch: t`Branch ${name}`,
    each: scope.guarded
      ? t`For each ${name}, while it holds`
      : t`For each ${name}`,
    try: t`Try`,
    catch: t`If it fails`,
    do: t`Steps`,
  }[scope.kind];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground">{heading}</span>
      <NextText next={scope.next} />
    </div>
  );
};

const TaskList = ({
  tasks,
  states,
}: {
  tasks: readonly DiagramTask[];
  states: ReadonlyMap<string, TraceState>;
}) => (
  <ol className="flex flex-col gap-2">
    {tasks.map((task) => (
      // eslint-disable-next-line no-use-before-define -- tasks nest in tasks
      <TaskItem key={task.pointer} states={states} task={task} />
    ))}
  </ol>
);

const TaskItem = ({
  task,
  states,
}: {
  task: DiagramTask;
  states: ReadonlyMap<string, TraceState>;
}) => {
  const { t } = useLingui();
  const state = states.get(task.id);
  return (
    <li
      aria-label={task.id}
      className="bg-card flex flex-col gap-2 rounded-lg border p-3"
      data-state={state ?? "none"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-medium">{task.id}</code>
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
                <TaskList states={states} tasks={scope.tasks} />
              )}
            </div>
          ))}
        </div>
      )}
    </li>
  );
};

/** No run shown: no task marked. */
const noStates: ReadonlyMap<string, TraceState> = new Map();

/**
 * `diagram`, with the tasks a run reached marked as `states` says: none
 * when no run is shown.
 */
export const WorkflowDiagramView = ({
  diagram,
  states = noStates,
  label,
}: {
  diagram: WorkflowDiagram;
  states?: ReadonlyMap<string, TraceState>;
  label: string;
}) => (
  <section aria-label={label} className="flex flex-col gap-2">
    {diagram.tasks.length === 0 ? (
      <p className="text-muted-foreground">
        <Trans>It declares no tasks.</Trans>
      </p>
    ) : (
      <TaskList states={states} tasks={diagram.tasks} />
    )}
  </section>
);
